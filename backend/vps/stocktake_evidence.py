"""Private bounded binary photo evidence; no multipart or public file paths."""
import asyncio
import hashlib
from io import BytesIO
import threading
import time
from typing import Annotated
import uuid
import warnings

from fastapi import Depends, Request, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

MAX_RAW_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 12_000_000
MAX_DIMENSION = 8192
MAX_STORED_BYTES = 1024 * 1024
STORE_QUOTA_BYTES = 256 * 1024 * 1024
STREAM_TIMEOUT_SECONDS = 30
_decode_lock = threading.BoundedSemaphore(1)
METADATA_COLUMNS = "id,client_upload_id,client_stocktake_id,lot_id,sha256,mime,width,height,byte_size,created_at"


def metadata(row, *, duplicate=None):
    result = {key: row[key] for key in METADATA_COLUMNS.split(",") if key != "id"}
    result["evidence_id"] = row["id"]
    if duplicate is not None:
        result["duplicate"] = duplicate
    return result


def normalize_image(raw, declared_type):
    expected = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
    if declared_type not in expected:
        raise ValueError("Unsupported image content type")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(BytesIO(raw), formats=("JPEG", "PNG", "WEBP")) as image:
                width, height = image.size
                if image.format != expected[declared_type] or image.format not in ("JPEG", "PNG", "WEBP"):
                    raise ValueError("Image content does not match declared format")
                if width < 1 or height < 1 or width > MAX_DIMENSION or height > MAX_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                    raise ValueError("Image dimensions exceed supported limits")
                if getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Animated images are not accepted")
                image.verify()
            with Image.open(BytesIO(raw), formats=("JPEG", "PNG", "WEBP")) as image:
                image.load()
                oriented = ImageOps.exif_transpose(image)
                oriented.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                rgb = oriented.convert("RGB")
                clean = Image.new("RGB", rgb.size)
                clean.paste(rgb)
                try:
                    for quality in (85, 75, 65, 55):
                        output = BytesIO()
                        clean.save(output, format="JPEG", quality=quality, optimize=False)
                        data = output.getvalue()
                        if len(data) <= MAX_STORED_BYTES:
                            return data, clean.width, clean.height
                    raise ValueError("Normalized image exceeds supported size")
                finally:
                    clean.close()
                    rgb.close()
                    if oriented is not image:
                        oriented.close()
        except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError,
                Image.DecompressionBombWarning) as exc:
            raise ValueError("Invalid, truncated or oversized image") from exc


def register_evidence_routes(app, path, connect, current, require_manager, error, now_utc, uuid_str, *,
                             authorize_pos_write, recheck_actor):
    @app.post("/v1/stocktake-evidence/{client_upload_id}")
    async def upload(client_upload_id: uuid.UUID, lot_id: uuid.UUID, client_stocktake_id: uuid.UUID,
                     request: Request, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in ("image/jpeg", "image/png", "image/webp"):
            error(415, "JPEG, PNG or WebP image required")
        length = request.headers.get("content-length")
        if length is not None:
            try:
                if int(length) < 1 or int(length) > MAX_RAW_BYTES:
                    error(413, "Image exceeds 5 MiB limit")
            except ValueError:
                error(400, "Invalid content length")
        with connect(path) as db:
            if not db.execute("SELECT id FROM lots WHERE id=? AND store_id=?", (str(lot_id), actor["store_id"])).fetchone():
                error(422, "Lot unavailable in this store")
            if not db.execute("SELECT id FROM stocktake_evidence WHERE store_id=? AND client_upload_id=?",
                              (actor["store_id"], str(client_upload_id))).fetchone():
                used = db.execute("SELECT coalesce(sum(byte_size),0) FROM stocktake_evidence WHERE store_id=?", (actor["store_id"],)).fetchone()[0]
                if used >= STORE_QUOTA_BYTES:
                    error(409, "EVIDENCE_STORAGE_FULL")
        if not _decode_lock.acquire(blocking=False):
            error(429, "Image processing busy; retry the same upload UUID")
        try:
            raw = bytearray()
            try:
                async with asyncio.timeout(STREAM_TIMEOUT_SECONDS):
                    async for chunk in request.stream():
                        if len(raw) + len(chunk) > MAX_RAW_BYTES:
                            error(413, "Image exceeds 5 MiB limit")
                        raw.extend(chunk)
            except TimeoutError:
                error(408, "Image upload timed out; retry the same upload UUID")
            if not raw:
                error(422, "Empty image")
            source_hash = hashlib.sha256(raw).hexdigest()
            with connect(path) as db:
                existing = db.execute("SELECT " + METADATA_COLUMNS + ",actor_user_id,source_sha256 FROM stocktake_evidence "
                    "WHERE store_id=? AND client_upload_id=?", (actor["store_id"], str(client_upload_id))).fetchone()
                if existing:
                    actor = recheck_actor(db, request.headers.get("authorization"), actor)
                    require_manager(actor)
                    if (existing["actor_user_id"] != actor["id"] or existing["source_sha256"] != source_hash or
                            existing["lot_id"] != str(lot_id) or existing["client_stocktake_id"] != str(client_stocktake_id)):
                        error(409, "Evidence UUID already used with different image or context")
                    return metadata(existing, duplicate=True)
            try:
                image, width, height = await run_in_threadpool(normalize_image, bytes(raw), content_type)
            except ValueError as exc:
                error(422, str(exc))
            with connect(path) as db:
                try:
                    db.execute("BEGIN IMMEDIATE")
                    actor = recheck_actor(db, request.headers.get("authorization"), actor)
                    require_manager(actor)
                    raced = db.execute("SELECT " + METADATA_COLUMNS + ",actor_user_id,source_sha256 FROM stocktake_evidence "
                        "WHERE store_id=? AND client_upload_id=?", (actor["store_id"], str(client_upload_id))).fetchone()
                    if raced:
                        if (raced["actor_user_id"] != actor["id"] or raced["source_sha256"] != source_hash or
                                raced["lot_id"] != str(lot_id) or raced["client_stocktake_id"] != str(client_stocktake_id)):
                            error(409, "Evidence UUID already used with different image or context")
                        result = metadata(raced, duplicate=True)
                        db.rollback()
                        return result
                    actor = authorize_pos_write(db, request.headers.get("authorization"), actor)
                    require_manager(actor)
                    if not db.execute("SELECT id FROM lots WHERE id=? AND store_id=?", (str(lot_id), actor["store_id"])).fetchone():
                        error(422, "Lot unavailable in this store")
                    if db.execute("SELECT id FROM stocktakes WHERE store_id=? AND client_stocktake_id=?",
                                  (actor["store_id"], str(client_stocktake_id))).fetchone():
                        error(409, "Stocktake already completed")
                    if db.execute("SELECT client_stocktake_id FROM stocktake_rejections WHERE store_id=? AND client_stocktake_id=?",
                                  (actor["store_id"], str(client_stocktake_id))).fetchone():
                        error(409, "Stocktake was rejected; begin a new count")
                    used = db.execute("SELECT coalesce(sum(byte_size),0) FROM stocktake_evidence WHERE store_id=?",
                                      (actor["store_id"],)).fetchone()[0]
                    if used + len(image) > STORE_QUOTA_BYTES:
                        error(409, "EVIDENCE_STORAGE_FULL")
                    evidence_id = uuid_str()
                    db.execute("INSERT INTO stocktake_evidence(id,store_id,actor_user_id,actor_email,client_upload_id,"
                        "client_stocktake_id,lot_id,source_sha256,sha256,mime,width,height,byte_size,image_blob,created_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (evidence_id, actor["store_id"], actor["id"], actor["email"],
                        str(client_upload_id), str(client_stocktake_id), str(lot_id), source_hash, hashlib.sha256(image).hexdigest(),
                        "image/jpeg", width, height, len(image), image, now_utc()))
                    saved = db.execute("SELECT " + METADATA_COLUMNS + " FROM stocktake_evidence WHERE id=?", (evidence_id,)).fetchone()
                    result = metadata(saved, duplicate=False)
                    db.commit()
                    return result
                except Exception:
                    db.rollback()
                    raise
        finally:
            _decode_lock.release()

    @app.get("/v1/stocktake-evidence/by-client/{client_upload_id}")
    def lookup(client_upload_id: uuid.UUID, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        with connect(path) as db:
            row = db.execute("SELECT " + METADATA_COLUMNS + " FROM stocktake_evidence "
                "WHERE store_id=? AND client_upload_id=? AND actor_user_id=?",
                (actor["store_id"], str(client_upload_id), actor["id"])).fetchone()
            if not row:
                error(404, "Evidence not found")
            return metadata(row, duplicate=True)

    @app.get("/v1/stocktake-evidence/{evidence_id}")
    def image(evidence_id: uuid.UUID, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        with connect(path) as db:
            row = db.execute("SELECT image_blob,sha256 FROM stocktake_evidence WHERE id=? AND store_id=?",
                             (str(evidence_id), actor["store_id"])).fetchone()
            if not row:
                error(404, "Evidence not found")
            if hashlib.sha256(row["image_blob"]).hexdigest() != row["sha256"]:
                error(503, "Evidence integrity check failed")
            return Response(content=row["image_blob"], media_type="image/jpeg", headers={
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
