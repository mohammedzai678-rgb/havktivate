import subprocess
import os

print("Testing kicad-cli execution...")
cmd = [r"C:\Users\moham\AppData\Local\Programs\KiCad\10.0\bin\kicad-cli.exe", "version"]
res = subprocess.run(cmd, capture_output=True, text=True)
print("kicad-cli version:", res.stdout.strip())
