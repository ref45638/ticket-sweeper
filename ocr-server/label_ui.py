import os
import shutil
import tkinter as tk
from tkinter import messagebox
from PIL import Image, ImageTk

class CaptchaLabeler:
    def __init__(self, root):
        self.root = root
        self.root.title("驗證碼衝突解決小幫手")
        
        base_dir = os.path.dirname(os.path.abspath(__file__))
        self.conflict_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_conflict"))
        self.named_dir = os.path.abspath(os.path.join(base_dir, "..", "captchas_named"))
        
        os.makedirs(self.named_dir, exist_ok=True)
        
        self.files = [f for f in os.listdir(self.conflict_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
        self.current_idx = 0
        
        # UI Elements
        self.info_label = tk.Label(root, text="", font=("Arial", 14))
        self.info_label.pack(pady=5)
        
        # Image display
        self.img_label = tk.Label(root)
        self.img_label.pack(pady=10)
        
        btn_frame = tk.Frame(root)
        btn_frame.pack(pady=10)
        
        self.btn_left = tk.Button(btn_frame, text="左邊 [按鍵 1]", font=("Arial", 14), width=18, command=lambda: self.choose_option(1))
        self.btn_left.grid(row=0, column=0, padx=10)
        
        self.btn_right = tk.Button(btn_frame, text="右邊 [按鍵 2]", font=("Arial", 14), width=18, command=lambda: self.choose_option(2))
        self.btn_right.grid(row=0, column=1, padx=10)
        
        input_frame = tk.Frame(root)
        input_frame.pack(pady=10)
        
        tk.Label(input_frame, text="手動輸入:", font=("Arial", 12)).pack(side=tk.LEFT)
        self.custom_entry = tk.Entry(input_frame, font=("Arial", 14))
        self.custom_entry.pack(side=tk.LEFT, padx=5)
        self.custom_entry.bind('<Return>', lambda e: self.choose_custom())
        
        tk.Button(input_frame, text="送出 [Enter]", font=("Arial", 12), command=self.choose_custom).pack(side=tk.LEFT)
        
        tk.Button(root, text="跳過這張 [空白鍵]", font=("Arial", 12), command=self.next_image).pack(pady=15)
        
        # Key bindings
        self.root.bind('1', lambda e: self.choose_option(1))
        self.root.bind('2', lambda e: self.choose_option(2))
        self.root.bind('<space>', lambda e: self.next_image())
        
        self.load_image()
        
    def load_image(self):
        if self.current_idx >= len(self.files):
            messagebox.showinfo("完成", "恭喜！所有的衝突圖片都處理完畢了！")
            self.root.quit()
            return
            
        self.filename = self.files[self.current_idx]
        file_path = os.path.join(self.conflict_dir, self.filename)
        
        # Parse names
        name, _ = os.path.splitext(self.filename)
        parts = name.split('_vs_')
        self.tix_pred = parts[0] if len(parts) > 0 else "Unknown"
        
        # handle counter in universal pred (e.g. abcd_vs_abed_1)
        if len(parts) > 1:
            uni_part = parts[1]
            uni_pred = uni_part.rsplit('_', 1)[0] if '_' in uni_part and uni_part.rsplit('_', 1)[1].isdigit() else uni_part
            self.uni_pred = uni_pred
        else:
            self.uni_pred = "Unknown"
            
        self.info_label.config(text=f"進度: {self.current_idx + 1} / {len(self.files)}")
        self.btn_left.config(text=f"Tixcraft模型: {self.tix_pred}\n(按 1)")
        self.btn_right.config(text=f"Universal模型: {self.uni_pred}\n(按 2)")
        self.custom_entry.delete(0, tk.END)
        
        img = Image.open(file_path)
        # scale up 3x for easier reading
        img = img.resize((img.width * 3, img.height * 3), Image.NEAREST)
        self.tk_img = ImageTk.PhotoImage(img)
        self.img_label.config(image=self.tk_img)
        self.root.focus_set()
        
    def resolve(self, final_text):
        # Sanitize final_text
        for c in '<>:"/\\|?*':
            final_text = final_text.replace(c, '_')
            
        file_path = os.path.join(self.conflict_dir, self.filename)
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
        
    def choose_option(self, opt):
        if self.root.focus_get() == self.custom_entry:
            return # Don't trigger hotkeys if typing in custom box
            
        if opt == 1:
            self.resolve(self.tix_pred)
        elif opt == 2:
            self.resolve(self.uni_pred)
            
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
    
    app = CaptchaLabeler(root)
    root.focus_set()
    root.mainloop()
