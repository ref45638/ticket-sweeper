import os
import shutil
import tkinter as tk
from tkinter import messagebox
from PIL import Image, ImageTk
import re

class ErrorLabeler:
    def __init__(self, root):
        self.root = root
        self.root.title("錯誤驗證碼修正小幫手")
        
        base_dir = os.path.dirname(os.path.abspath(__file__))
        self.error_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_error"))
        self.named_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_named"))
        
        os.makedirs(self.named_dir, exist_ok=True)
        
        self.files = [f for f in os.listdir(self.error_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
        self.current_idx = 0
        
        # UI Elements
        self.info_label = tk.Label(root, text="", font=("Arial", 14))
        self.info_label.pack(pady=5)
        
        # Image display
        self.img_label = tk.Label(root)
        self.img_label.pack(pady=10)
        
        self.pred_label = tk.Label(root, text="", font=("Arial", 14, "bold"), fg="red")
        self.pred_label.pack(pady=5)
        
        input_frame = tk.Frame(root)
        input_frame.pack(pady=10)
        
        tk.Label(input_frame, text="請修正:", font=("Arial", 12)).pack(side=tk.LEFT)
        self.custom_entry = tk.Entry(input_frame, font=("Arial", 16), width=10)
        self.custom_entry.pack(side=tk.LEFT, padx=5)
        self.custom_entry.bind('<Return>', lambda e: self.choose_custom())
        
        tk.Button(input_frame, text="送出 [Enter]", font=("Arial", 12), command=self.choose_custom).pack(side=tk.LEFT, padx=10)
        
        tk.Button(root, text="跳過這張 [空白鍵]", font=("Arial", 12), command=self.next_image).pack(pady=15)
        
        # Key bindings (For space to work globally, we bind to root)
        # Note: If typing space in entry, it might trigger skip. So we handle it inside next_image or don't bind space globally.
        # Actually, space is rarely used in captcha, so binding to root is okay, 
        # but let's bind Escape to skip instead, which is safer when typing.
        self.root.bind('<Escape>', lambda e: self.next_image())
        # Update button text to reflect new hotkey
        tk.Label(root, text="提示: 若遇到看不懂的，可以按 [Esc] 鍵跳過", font=("Arial", 10, "italic"), fg="gray").pack(pady=5)
        
        self.load_image()
        
    def load_image(self):
        if self.current_idx >= len(self.files):
            messagebox.showinfo("完成", "恭喜！所有的錯誤圖片都處理完畢了！")
            self.root.quit()
            return
            
        self.filename = self.files[self.current_idx]
        file_path = os.path.join(self.error_dir, self.filename)
        
        # Parse current prediction from filename (e.g., abc_err1.jpg -> abc)
        name, _ = os.path.splitext(self.filename)
        match = re.fullmatch(r'(.*?)_err\d+', name)
        if match:
            self.current_pred = match.group(1)
        else:
            self.current_pred = name
            
        self.info_label.config(text=f"進度: {self.current_idx + 1} / {len(self.files)}")
        self.pred_label.config(text=f"原本辨識為: {self.current_pred}")
        
        # Pre-fill entry and focus
        self.custom_entry.delete(0, tk.END)
        self.custom_entry.insert(0, self.current_pred)
        self.custom_entry.focus_set()
        # Move cursor to the end
        self.custom_entry.icursor(tk.END)
        
        img = Image.open(file_path)
        # scale up 3x for easier reading
        img = img.resize((img.width * 3, img.height * 3), Image.NEAREST)
        self.tk_img = ImageTk.PhotoImage(img)
        self.img_label.config(image=self.tk_img)
        
    def resolve(self, final_text):
        # Sanitize final_text
        for c in '<>:"/\\|?*':
            final_text = final_text.replace(c, '_')
            
        file_path = os.path.join(self.error_dir, self.filename)
        ext = os.path.splitext(self.filename)[1]
        
        new_filename = f"{final_text}{ext}"
        new_file_path = os.path.join(self.named_dir, new_filename)
        
        counter = 1
        while os.path.exists(new_file_path):
            new_filename = f"{final_text}_{counter}{ext}"
            new_file_path = os.path.join(self.named_dir, new_filename)
            counter += 1
            
        try:
            shutil.move(file_path, new_file_path)
        except Exception as e:
            messagebox.showerror("Error", f"Failed to move file: {e}")
            
        self.next_image()
            
    def choose_custom(self):
        val = self.custom_entry.get().strip()
        if val:
            self.resolve(val)
            
    def next_image(self):
        self.current_idx += 1
        self.load_image()

if __name__ == "__main__":
    root = tk.Tk()
    
    # Put window in front
    root.lift()
    root.attributes('-topmost',True)
    root.after_idle(root.attributes,'-topmost',False)
    
    app = ErrorLabeler(root)
    root.mainloop()
