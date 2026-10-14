import subprocess
import uuid
from pathlib import Path

test_pcb = Path(r"c:\Users\moham\Desktop\msrus\hardware\test_u1.kicad_pcb")
def u(): return str(uuid.uuid4())

def make_pcb(max_y):
    pads = []
    for i in range(1, 20):
        y_rel = (i - 1) * 2.54
        shape = "rect" if i == 1 else "circle"
        pads.append(f'(pad "{i}" thru_hole {shape} (at 0 {y_rel:.2f}) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net 0 "") (uuid "{u()}"))')
    pads_str = "\n    ".join(pads)

    content = f"""(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (setup (pad_to_mask_clearance 0))
  (net 0 "")

  (gr_line (start 5 5) (end 95 5) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 95 5) (end 95 {max_y}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 95 {max_y}) (end 5 {max_y}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 5 {max_y}) (end 5 5) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))

  (footprint "Connector_PinHeader_2.54mm:PinHeader_1x19_P2.54mm_Vertical"
    (version 20260206)
    (layer "F.Cu")
    (uuid "{u()}")
    (at 35 35)
    (property "Reference" "U1_L" (at 0 -2.54 0) (layer "F.SilkS") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "ESP32_DevKit_Left" (at 0 48 0) (layer "F.Fab") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Footprint" "Connector_PinHeader_2.54mm:PinHeader_1x19_P2.54mm_Vertical" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Datasheet" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Description" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    {pads_str}
  )
)
"""
    test_pcb.write_text(content, encoding="utf-8")
    cmd = [
        r"C:\Users\moham\AppData\Local\Programs\KiCad\10.0\bin\kicad-cli.exe",
        "pcb", "drc", "--output", r"c:\Users\moham\Desktop\msrus\hardware\drc_u1.rpt", str(test_pcb)
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    rpt = Path(r"c:\Users\moham\Desktop\msrus\hardware\drc_u1.rpt").read_text(encoding="utf-8")
    print(f"--- DRC with max_y={max_y} ---")
    print(rpt)

make_pcb(80)
make_pcb(85)
