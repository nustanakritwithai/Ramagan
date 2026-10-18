"""Synthetic scale-style image upload helper; never opens a real image or shop."""
from io import BytesIO
import uuid
from PIL import Image, ImageDraw


def photo_bytes():
    image = Image.new("RGB", (200, 120), "white")
    ImageDraw.Draw(image).text((20, 45), "SYNTHETIC 5.000 g", fill="black")
    stream = BytesIO()
    image.save(stream, format="JPEG")
    image.close()
    return stream.getvalue()


def upload_photo(client, headers, lot_id, count_id):
    result = client.post("/v1/stocktake-evidence/" + str(uuid.uuid4()),
        params={"lot_id": lot_id, "client_stocktake_id": count_id},
        headers={**headers, "Content-Type": "image/jpeg"}, content=photo_bytes())
    if result.status_code != 200:
        raise AssertionError("Synthetic evidence upload failed: " + str(result.status_code))
    return result.json()
