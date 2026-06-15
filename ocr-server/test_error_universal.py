import os
import ddddocr

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(base_dir, "assets", "model", "universal", "custom.onnx")
    charsets_path = os.path.join(base_dir, "assets", "model", "universal", "charsets.json")
    
    error_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_error"))
    
    print(f"Loading ONNX model from: {model_path}")
    try:
        ocr = ddddocr.DdddOcr(
            det=False, ocr=False, show_ad=False,
            import_onnx_path=model_path,
            charsets_path=charsets_path
        )
        print("Universal OCR Model loaded successfully.")
    except Exception as e:
        print(f"Failed to load ddddocr model: {e}")
        return
        
    files = [f for f in os.listdir(error_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    print(f"Found {len(files)} images to test in {error_dir}.")
    
    four_char_count = 0
    other_count = 0
    
    for filename in files:
        file_path = os.path.join(error_dir, filename)
        try:
            with open(file_path, 'rb') as f:
                image_bytes = f.read()
            text = ocr.classification(image_bytes)
            
            if len(text) == 4:
                four_char_count += 1
                # print(f"[4 chars] {filename} -> {text}")
            else:
                other_count += 1
                
        except Exception as e:
            print(f"Error processing {filename}: {e}")
            
    print(f"Done testing! Universal model predicted 4 characters for {four_char_count} images.")
    print(f"Universal model predicted non-4 characters for {other_count} images.")

if __name__ == "__main__":
    main()
