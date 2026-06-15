from fastapi import FastAPI
import ddddocr
import os
import base64
from pydantic import BaseModel
import uvicorn

app = FastAPI()

# 初始化 ddddocr
# 模型路徑與 charset 路徑
base_dir = os.path.dirname(__file__)
model_path = os.path.join(base_dir, "assets", "model", "tixcraft_tm", "custom.onnx")
charsets_path = os.path.join(base_dir, "assets", "model", "tixcraft_tm", "charsets.json")

# 確保路徑為絕對路徑
model_path = os.path.abspath(model_path)
charsets_path = os.path.abspath(charsets_path)

print(f"Loading ONNX model from: {model_path}")
print(f"Loading charsets from: {charsets_path}")

try:
    ocr = ddddocr.DdddOcr(
        det=False, ocr=False, show_ad=False,
        import_onnx_path=model_path,
        charsets_path=charsets_path
    )
    print("OCR Model loaded successfully.")
except Exception as e:
    print(f"Failed to load ddddocr model: {e}")
    ocr = None

class Base64ImageRequest(BaseModel):
    image_base64: str

@app.post("/ocr/base64")
async def recognize_base64(request: Base64ImageRequest):
    if not ocr:
        return {"success": False, "error": "OCR Model not loaded."}
    
    try:
        # 解碼 base64
        # 有些傳進來的 Base64 可能會帶有 "data:image/png;base64," 前綴，安全起見將其移除
        b64_data = request.image_base64
        if "," in b64_data:
            b64_data = b64_data.split(",")[1]
            
        image_bytes = base64.b64decode(b64_data)
        
        # 進行 OCR 辨識
        result = ocr.classification(image_bytes)
        return {"success": True, "text": result}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/health")
def health_check():
    return {"status": "ok", "model_loaded": ocr is not None}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, use_colors=False)
