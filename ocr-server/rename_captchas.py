import os
import shutil
import ddddocr

def main():
    # Setup paths
    base_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(base_dir, "assets", "model", "tixcraft_tm", "custom.onnx")
    charsets_path = os.path.join(base_dir, "assets", "model", "tixcraft_tm", "charsets.json")
    
    captchas_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas"))
    captchas_named_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_named"))
    
    # Ensure target directory exists
    os.makedirs(captchas_named_dir, exist_ok=True)
    
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
    
    if not os.path.exists(captchas_dir):
        print(f"Source directory does not exist: {captchas_dir}")
        return
        
    files = [f for f in os.listdir(captchas_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    print(f"Found {len(files)} images to process.")
    
    success_count = 0
    error_count = 0
    
    for filename in files:
        file_path = os.path.join(captchas_dir, filename)
        
        try:
            with open(file_path, 'rb') as f:
                image_bytes = f.read()
                
            text = ocr.classification(image_bytes)
            
            if not text:
                text = "unknown"
                
            # Replace invalid windows filename chars if any
            invalid_chars = '<>:"/\\|?*'
            for c in invalid_chars:
                text = text.replace(c, '_')
                
            # Construct new filename
            ext = os.path.splitext(filename)[1]
            new_filename = f"{text}{ext}"
            new_file_path = os.path.join(captchas_named_dir, new_filename)
            
            # Handle duplicates
            counter = 1
            while os.path.exists(new_file_path):
                new_filename = f"{text}_{counter}{ext}"
                new_file_path = os.path.join(captchas_named_dir, new_filename)
                counter += 1
                
            shutil.move(file_path, new_file_path)
            print(f"Moved: {filename} -> {new_filename}")
            success_count += 1
            
        except Exception as e:
            print(f"Error processing {filename}: {e}")
            error_count += 1

    print(f"Done! Successfully processed: {success_count}, Errors: {error_count}")

if __name__ == "__main__":
    main()
