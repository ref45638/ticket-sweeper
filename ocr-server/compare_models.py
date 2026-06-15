import os
import ddddocr
import re

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(base_dir, "assets", "model", "universal", "custom.onnx")
    charsets_path = os.path.join(base_dir, "assets", "model", "universal", "charsets.json")
    
    named_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_named"))
    
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
    
    diff_count = 0
    total_4_char = 0
    
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
            
            if len(uni_pred) == 4:
                total_4_char += 1
                if uni_pred != tix_pred:
                    diff_count += 1
                    
        except Exception as e:
            print(f"Error processing {filename}: {e}")
            
    print(f"Done! Universal model predicted 4 characters for {total_4_char} images.")
    print(f"Out of those, the universal prediction is DIFFERENT from the current name for: {diff_count} images.")

if __name__ == "__main__":
    main()
