import os
import shutil
import re

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    named_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_named"))
    error_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_error"))
    
    if not os.path.exists(named_dir):
        print(f"Source directory does not exist: {named_dir}")
        return
        
    os.makedirs(error_dir, exist_ok=True)
    
    files = [f for f in os.listdir(named_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    
    count = 0
    for filename in files:
        name, ext = os.path.splitext(filename)
        
        # Extract the OCR text part (everything before the last _number, or the whole name)
        # Our previous script named files like {text}.jpg or {text}_{counter}.jpg
        # Since text usually doesn't contain '_', splitting by '_' and taking the first part works.
        # To be completely safe and handle potential '_' in text, we can do a regex check.
        # But split('_')[0] is usually sufficient if original text had no underscores.
        # Actually, let's use rsplit if it ends with _\d+
        
        match = re.fullmatch(r'(.*?)_\d+', name)
        if match:
            text = match.group(1)
        else:
            text = name
            
        if len(text) == 3:
            src = os.path.join(named_dir, filename)
            
            # Handle duplicates in destination
            new_filename = filename
            dst = os.path.join(error_dir, new_filename)
            counter = 1
            while os.path.exists(dst):
                new_filename = f"{name}_err{counter}{ext}"
                dst = os.path.join(error_dir, new_filename)
                counter += 1
                
            shutil.move(src, dst)
            print(f"Moved {filename} -> {new_filename} (Text: {text})")
            count += 1
            
    print(f"Done! Moved {count} images with 3 characters to captchas_error.")

if __name__ == "__main__":
    main()
