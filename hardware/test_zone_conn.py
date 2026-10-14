import subprocess
import uuid
from pathlib import Path

test_pcb = Path(r"c:\Users\moham\Desktop\msrus\hardware\test_zone_conn.kicad_pcb")
def u(): return str(uuid.uuid4())

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
  (net 1 "GND")

  (gr_line (start 5 5) (end 95 5) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 95 5) (end 95 85) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 95 85) (end 5 85) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 5 85) (end 5 5) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))

  (footprint "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical"
    (version 20260206) (layer "F.Cu") (uuid "{u()}") (at 20 20)
    (property "Reference" "J1" (at 0 -2 0) (layer "F.SilkS") (uuid "{u()}") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "Conn" (at 0 5 0) (layer "F.Fab") (uuid "{u()}") (effects (font (size 1 1) (thickness 0.15))))
    (property "Footprint" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}") (effects (font (size 1 1) (thickness 0.15))))
    (property "Datasheet" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}") (effects (font (size 1 1) (thickness 0.15))))
    (property "Description" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net 1 "GND") (uuid "{u()}"))
    (pad "2" thru_hole circle (at 0 2.54) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net 1 "GND") (uuid "{u()}"))
  )

  (zone
    (net 1)
    (net_name "GND")
    (layers "B.Cu")
    (uuid "{u()}")
    (hatch edge 0.5)
    (connect_pads yes (clearance 0.5))
    (min_thickness 0.25)
    (filled_areas_thickness no)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon
      (pts (xy 5 5) (xy 95 5) (xy 95 85) (xy 5 85))
    )
  )
)
"""
test_pcb.write_text(content, encoding="utf-8")
cmd = [
    r"C:\Users\moham\AppData\Local\Programs\KiCad\10.0\bin\kicad-cli.exe",
    "pcb", "drc", "--output", r"c:\Users\moham\Desktop\msrus\hardware\drc_zone.rpt", str(test_pcb)
]
res = subprocess.run(cmd, capture_output=True, text=True)
rpt = Path(r"c:\Users\moham\Desktop\msrus\hardware\drc_zone.rpt").read_text(encoding="utf-8")
print(rpt)
