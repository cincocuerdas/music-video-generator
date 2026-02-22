from rembg import remove
from PIL import Image
import os
import glob

# 1. Definir rutas
current_dir = os.getcwd()
# Intentamos guardar directo en el frontend si existe, sino en local
client_assets = os.path.join(current_dir, 'client', 'public', 'assets')
local_assets = os.path.join(current_dir, 'assets')

target_folder = client_assets if os.path.exists(os.path.join(current_dir, 'client')) else local_assets
os.makedirs(target_folder, exist_ok=True)

print(f"🎯 Destino de los archivos: {target_folder}")

# 2. Buscar archivos (incluso con doble extensión .png.png)
patterns = ["*body*.png*", "*crank*.png*", "*Gemini_Generated_Image_7e8iew7e8iew7e8i.png*"]
found_files = []
for p in patterns:
    found_files.extend(glob.glob(p))

if not found_files:
    print("❌ No encontré las imágenes (ni body ni crank).")
else:
    for file_path in found_files:
        print(f"🎨 Procesando: {file_path}...")
        try:
            inp = Image.open(file_path)
            output = remove(inp)
            
            # Nombre final limpio (sin doble extensión)
            if "body" in file_path:
                final_name = "camera-body.png"
            elif "crank" in file_path:
                final_name = "camera-crank.png"
            else:
                final_name = "processed_image.png"
            
            save_path = os.path.join(target_folder, final_name)
            output.save(save_path)
            print(f"   ✅ ÉXITO: Guardado en -> {save_path}")
            
        except Exception as e:
            print(f"   ❌ Error: {e}")

print("🏁 Proceso terminado.")