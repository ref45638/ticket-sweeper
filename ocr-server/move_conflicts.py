import os
import shutil
import ddddocr
import re

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(base_dir, "assets", "model", "universal", "custom.onnx")
    charsets_path = os.path.join(base_dir, "assets", "model", "universal", "charsets.json")
    
    named_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_named"))
    conflict_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_conflict"))
    
    os.makedirs(conflict_dir, exist_ok=True)
    
    print(f"Loading Universal ONNX model from: {model_path}")
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
        
    files = [f for f in os.listdir(named_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    print(f"Found {len(files)} images to verify in {named_dir}.")
    
    moved_count = 0
    
    for filename in files:
        name, ext = os.path.splitext(filename)
        
        # Extract the original prediction from filename
        match = re.fullmatch(r'(.*?)_\d+', name)
        if match:
            tix_pred = match.group(1)
        else:
            tix_pred = name
            
        file_path = os.path.join(named_dir, filename)
        try:
            with open(file_path, 'rb') as f:
                image_bytes = f.read()
            
            uni_pred = ocr.classification(image_bytes)
            
            if len(uni_pred) == 4 and uni_pred != tix_pred:
                # Replace invalid filename chars just in case
                invalid_chars = '<>:"/\\|?*'
                safe_uni = uni_pred
                for c in invalid_chars:
                    safe_uni = safe_uni.replace(c, '_')
                    
                # Format: tixcraft_vs_universal
                new_filename = f"{tix_pred}_vs_{safe_uni}{ext}"
                new_file_path = os.path.join(conflict_dir, new_filename)
                
                # Handle duplicates
                counter = 1
                while os.path.exists(new_file_path):
                    new_filename = f"{tix_pred}_vs_{safe_uni}_{counter}{ext}"
                    new_file_path = os.path.join(conflict_dir, new_filename)
                    counter += 1
                    
                shutil.move(file_path, new_file_path)
                moved_count += 1
                
        except Exception as e:
            print(f"Error processing {filename}: {e}")
            
    print(f"Done! Moved {moved_count} conflicting images to {conflict_dir}.")

if __name__ == "__main__":
    main()
