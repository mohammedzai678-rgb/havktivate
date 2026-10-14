import subprocess
from pathlib import Path

pcb_file = Path(r"c:\Users\moham\Desktop\msrus\hardware\jeevancare.kicad_pcb")

cmd = [
    r"C:\Users\moham\AppData\Local\Programs\KiCad\10.0\bin\python.exe",
    "-c",
    f"""import pcbnew
b = pcbnew.LoadBoard(r'{pcb_file}')
filler = pcbnew.ZONE_FILLER(b)
filler.Fill(b.Zones())
b.Save(r'{pcb_file}')
print('Zones filled successfully!')
"""
]

res = subprocess.run(cmd, capture_output=True, text=True)
print(res.stdout)
print(res.stderr)

drc_cmd = [
    r"C:\Users\moham\AppData\Local\Programs\KiCad\10.0\bin\kicad-cli.exe",
    "pcb", "drc", "--output", r"c:\Users\moham\Desktop\msrus\hardware\drc_after_fill.rpt", str(pcb_file)
]
res_drc = subprocess.run(drc_cmd, capture_output=True, text=True)
rpt = Path(r"c:\Users\moham\Desktop\msrus\hardware\drc_after_fill.rpt").read_text(encoding="utf-8")
lines = rpt.splitlines()
for l in lines[:30]:
    print(l)
for l in lines:
    if "unconnected" in l.lower() or "violation" in l.lower():
        print("-->", l)
