"""One real HTTP workflow using only a disposable SQLite and temporary listener."""
import atexit
from contextlib import closing
from datetime import datetime
import os
from pathlib import Path
import secrets
import socket
import tempfile
import threading
import time
import unittest
import uuid
from zoneinfo import ZoneInfo

_bootstrap=tempfile.TemporaryDirectory(prefix="cost-http-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"]=str(Path(_bootstrap.name)/"import.sqlite3")
import httpx
import uvicorn
from app import connect,create_app,create_store,create_user

class CostStockHttpTests(unittest.TestCase):
    def test_http_intake_sale_cost_count_replay_reports_and_roles(self):
        with tempfile.TemporaryDirectory(prefix="cost-stock-wire-fixture-") as folder:
            path=str(Path(folder)/"fixture.sqlite3")
            api=create_app(path,origins=["https://localhost","https://nustanakritwithai.github.io"])
            store=create_store(path,"DISPOSABLE WIRE FIXTURE ONLY")
            other=create_store(path,"DISPOSABLE OTHER TENANT")
            credentials={}
            for role in ("owner","manager","staff","other"):
                password=secrets.token_urlsafe(32)
                email=role+"@cost-wire.invalid"
                create_user(path,other if role=="other" else store,email,password,"owner" if role=="other" else role)
                credentials[role]=(email,password)
            with connect(path) as db:
                # Explicitly enable ONLY this disposable shop and optional document fixture.
                db.execute("UPDATE stores SET sales_enabled=1,requires_authorization=0 WHERE id=?",(store,))
            sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
            sock.bind(("127.0.0.1",0))
            port=sock.getsockname()[1]
            server=uvicorn.Server(uvicorn.Config(api,host="127.0.0.1",port=port,log_level="critical",access_log=False,lifespan="off"))
            worker=threading.Thread(target=server.run,kwargs={"sockets":[sock]},daemon=True)
            worker.start()
            try:
                deadline=time.monotonic()+10
                while not server.started and worker.is_alive() and time.monotonic()<deadline:time.sleep(.01)
                self.assertTrue(server.started)
                with httpx.Client(base_url=f"http://127.0.0.1:{port}",trust_env=False,timeout=10) as client:
                    headers={}
                    for role,(email,password) in credentials.items():
                        login=client.post("/v1/auth/login",json={"email":email,"password":password})
                        self.assertEqual(login.status_code,200)
                        headers[role]={"Authorization":"Bearer "+login.json()["token"]}
                    me=client.get("/v1/me",headers=headers["owner"]).json()
                    self.assertTrue(me["capabilities"]["inventory_costs"])
                    self.assertEqual(me["capabilities"]["cost_contract_version"],1)
                    self.assertTrue(me["capabilities"]["optional_document_references"])
                    self.assertFalse(me["store"]["requires_authorization"])
                    health=client.get("/health").json()
                    self.assertEqual(health["schema_version"],3)
                    self.assertEqual(health["version"],"1.2.0-vps-preview")
                    product=client.post("/v1/products",headers=headers["owner"],json={"sku":"WIRE","name":"SYNTHETIC","category":"fixture","price_satang_per_gram":10000,"default_cost_satang_per_gram":4000})
                    self.assertEqual(product.status_code,200)
                    pid=product.json()["product_id"]
                    intake={"client_receive_id":str(uuid.uuid4()),"product_id":pid,"lot_code":"WIRE-ONLY","supplier_name":"Synthetic","quantity_mg":10000,"reason":"Disposable fixture only"}
                    first=client.post("/v1/lots/receive",headers=headers["owner"],json=intake)
                    self.assertEqual(first.status_code,200,first.text)
                    receipt=first.json();lot=receipt["lot_id"]
                    self.assertEqual(receipt["cost_satang_per_gram"],4000)
                    self.assertFalse(receipt["duplicate"])
                    with connect(path) as db:
                        self.assertEqual(db.execute("SELECT supplier_document_ref FROM lots WHERE id=?",(lot,)).fetchone()[0],"")
                        db.execute("UPDATE products SET default_cost_satang_per_gram=9000 WHERE id=?",(pid,))
                    retry=client.post("/v1/lots/receive",headers=headers["owner"],json=intake)
                    self.assertEqual(retry.status_code,200)
                    self.assertEqual(retry.json(),{**receipt,"duplicate":True})
                    receipt_completed=client.post("/v1/lots/receive/reconcile",headers=headers["owner"],json=intake)
                    self.assertEqual(receipt_completed.status_code,200)
                    self.assertEqual(receipt_completed.json()["status"],"completed")
                    self.assertEqual(receipt_completed.json()["result"],retry.json())
                    self.assertEqual(client.post("/v1/lots/receive",headers=headers["owner"],json={**intake,"cost_satang_per_gram":0}).status_code,409)
                    # Explicitly cancel a never-recorded UUID. Any delayed POST
                    # must now be rejected without creating another Lot/ledger.
                    lost_intake={**intake,"client_receive_id":str(uuid.uuid4()),"lot_code":"NEVER-RECORDED"}
                    cancelled=client.post("/v1/lots/receive/reconcile",headers=headers["owner"],json=lost_intake)
                    self.assertEqual(cancelled.status_code,200,cancelled.text)
                    self.assertEqual(cancelled.json()["status"],"rejected")
                    self.assertEqual(cancelled.json()["code"],"RECEIVE_CANCELLED")
                    self.assertFalse(cancelled.json()["committed"])
                    self.assertEqual(client.post("/v1/lots/receive",headers=headers["owner"],json=lost_intake).status_code,409)
                    sale_payload={"client_sale_id":str(uuid.uuid4()),"items":[{"lot_id":lot,"quantity_mg":1000}],"payment_method":"transfer","discount_satang":100}
                    sale=client.post("/v1/sales",headers=headers["staff"],json=sale_payload)
                    self.assertEqual(sale.status_code,200,sale.text)
                    self.assertEqual(sale.json()["total_satang"],9900)
                    inventory=client.get("/v1/inventory",headers=headers["manager"])
                    self.assertEqual(inventory.status_code,200)
                    row=inventory.json()["lots"][0]
                    self.assertEqual((row["quantity_mg"],row["stock_revision"],row["cost_satang_per_gram"]),(9000,1,4000))
                    self.assertEqual(inventory.json()["summary"]["inventory_value_satang"],36000)
                    count={"client_stocktake_id":str(uuid.uuid4()),"shift_label":"Morning","reason":"Physical count fixture","items":[{"lot_id":lot,"expected_revision":1,"counted_quantity_mg":8500}]}
                    count_result=client.post("/v1/stocktakes",headers=headers["owner"],json=count)
                    self.assertEqual(count_result.status_code,200,count_result.text)
                    saved=count_result.json()
                    self.assertEqual(saved["actor_user_id"],me["user"]["id"])
                    self.assertEqual(saved["items"][0]["variance_mg"],-500)
                    self.assertEqual(saved["items"][0]["inventory_delta_satang"],-2000)
                    replay=client.post("/v1/stocktakes",headers=headers["owner"],json=count)
                    self.assertEqual(replay.status_code,200)
                    self.assertEqual(replay.json(),{**saved,"duplicate":True})
                    lookup=client.get("/v1/stocktakes/by-client/"+count["client_stocktake_id"],headers=headers["owner"])
                    self.assertEqual(lookup.json(),replay.json())
                    stale={**count,"client_stocktake_id":str(uuid.uuid4())}
                    self.assertEqual(client.post("/v1/stocktakes",headers=headers["owner"],json=stale).status_code,409)
                    self.assertEqual(client.post("/v1/stocktakes",headers=headers["owner"],json={**count,"reason":"changed"}).status_code,409)
                    completed=client.post("/v1/stocktakes/reconcile",headers=headers["owner"],json=count)
                    self.assertEqual(completed.status_code,200)
                    self.assertEqual(completed.json()["status"],"completed")
                    self.assertEqual(completed.json()["result"],replay.json())
                    # A lost request that never arrived cannot remain stuck after
                    # another device changed stock: persist rejection before reset.
                    rejected=client.post("/v1/stocktakes/reconcile",headers=headers["owner"],json=stale)
                    self.assertEqual(rejected.status_code,200,rejected.text)
                    self.assertEqual(rejected.json()["status"],"rejected")
                    self.assertEqual(rejected.json()["client_stocktake_id"],stale["client_stocktake_id"])
                    self.assertFalse(rejected.json()["committed"])
                    self.assertEqual(client.post("/v1/stocktakes",headers=headers["owner"],json=stale).status_code,409)
                    fresh={**stale,"client_stocktake_id":str(uuid.uuid4()),"items":[{**stale["items"][0],"expected_revision":2}]}
                    pending=client.post("/v1/stocktakes/reconcile",headers=headers["owner"],json=fresh)
                    self.assertEqual(pending.status_code,200)
                    self.assertEqual(pending.json()["status"],"pending")
                    history=client.get("/v1/stocktakes",headers=headers["manager"]).json()["stocktakes"]
                    self.assertEqual(len(history),1)
                    self.assertEqual(history[0]["variance_mg"],-500)
                    self.assertEqual(client.get("/v1/inventory",headers=headers["staff"]).status_code,403)
                    self.assertEqual(client.get("/v1/stocktakes",headers=headers["staff"]).status_code,403)
                    self.assertEqual(client.post("/v1/stocktakes",headers=headers["staff"],json=stale).status_code,403)
                    staff_catalog=client.get("/v1/catalog",headers=headers["staff"]).json()
                    self.assertNotIn("default_cost_satang_per_gram",staff_catalog["products"][0])
                    self.assertNotIn("cost_satang_per_gram",staff_catalog["lots"][0])
                    self.assertEqual(client.get("/v1/stocktakes/by-client/"+count["client_stocktake_id"],headers=headers["other"]).status_code,404)
                    self.assertEqual(client.get("/v1/inventory",headers=headers["other"]).json()["lots"],[])
                    day=datetime.now(ZoneInfo("Asia/Bangkok")).date().isoformat()
                    report=client.get("/v1/admin/sales-report",headers=headers["manager"],params={"from":day,"to":day})
                    self.assertEqual(report.status_code,200)
                    data=report.json()
                    for section in [data["summary"],*data["daily"],*data["recent_sales"],*data["top_products"],*data["top_categories"]]:
                        self.assertEqual((section["subtotal_satang"],section["discount_satang"],section["total_satang"],section["cost_satang"],section["gross_profit_satang"]),(10000,100,9900,4000,5900))
                    self.assertEqual(client.get("/v1/admin/sales-report",headers=headers["staff"]).status_code,403)
                    with connect(path) as db:
                        self.assertEqual(db.execute("SELECT count(*) FROM lots").fetchone()[0],1)
                        self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0],1)
                        self.assertEqual(db.execute("SELECT count(*) FROM stocktakes").fetchone()[0],1)
                        self.assertEqual(db.execute("SELECT count(*) FROM ledger_events").fetchone()[0],3)
                        self.assertEqual(tuple(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances").fetchone()),(8500,2))
                        self.assertEqual(tuple(db.execute("SELECT unit_cost_satang_per_gram,line_cost_satang FROM sale_lines").fetchone()),(4000,4000))
                        self.assertEqual(db.execute("PRAGMA integrity_check").fetchall()[0][0],"ok")
                        self.assertFalse(db.execute("PRAGMA foreign_key_check").fetchall())
            finally:
                server.should_exit=True
                worker.join(timeout=10)
                sock.close()
                self.assertFalse(worker.is_alive(),"Disposable HTTP listener did not stop")

if __name__=="__main__":unittest.main()
