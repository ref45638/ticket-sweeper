import os
import shutil
import ddddocr

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(base_dir, "assets", "model", "tixcraft_tm", "custom.onnx")
    charsets_path = os.path.join(base_dir, "assets", "model", "tixcraft_tm", "charsets.json")
    
    captchas_named_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_named"))
    captchas_uncertain_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_uncertain"))
    
    os.makedirs(captchas_uncertain_dir, exist_ok=True)
    
    print(f"Loading ONNX model from: {model_path}")
    try:
        ocr = ddddocr.DdddOcr(
            det=False, ocr=False, show_ad=False,
            import_onnx_path=model_path,
            charsets_path=charsets_path
        )
        print("OCR Model loaded successfully.")
    except Exception as e:
        print(f"Failed to load ddddocr model: {e}")
        return
    
    if not os.path.exists(captchas_named_dir):
        print(f"Directory does not exist: {captchas_named_dir}")
        return
        
    files = [f for f in os.listdir(captchas_named_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    print(f"Found {len(files)} images to verify in {captchas_named_dir}.")
    
    uncertain_count = 0
    stable_count = 0
    
    for filename in files:
        file_path = os.path.join(captchas_named_dir, filename)
        
        try:
            with open(file_path, 'rb') as f:
                image_bytes = f.read()
            
            results = set()
            for _ in range(10):
                text = ocr.classification(image_bytes)
                if not text:
                    text = "unknown"
                results.add(text)
                
            if len(results) > 1:
                print(f"[Uncertain] {filename} -> results: {results}")
                # Move to uncertain directory
                new_file_path = os.path.join(captchas_uncertain_dir, filename)
                
                # Handle duplicates in destination just in case
                counter = 1
                base_name, ext = os.path.splitext(filename)
                while os.path.exists(new_file_path):
                    new_file_path = os.path.join(captchas_uncertain_dir, f"{base_name}_{counter}{ext}")
                    counter += 1
                    
                shutil.move(file_path, new_file_path)
                uncertain_count += 1
            else:
                stable_count += 1
                
        except Exception as e:
            print(f"Error processing {filename}: {e}")
            
    print(f"Done! Stable: {stable_count}, Uncertain: {uncertain_count}")

if __name__ == "__main__":
    main()
