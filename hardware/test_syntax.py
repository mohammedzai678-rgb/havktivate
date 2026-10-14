import subprocess
import uuid
from pathlib import Path

test_pcb = Path(r"c:\Users\moham\Desktop\msrus\hardware\test_syntax.kicad_pcb")

def u(): return str(uuid.uuid4())

content = f"""(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general
    (thickness 1.6)
    (legacy_teardrops no)
  )
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (32 "B.Adhes" user "B.Adhesive")
    (33 "F.Adhes" user "F.Adhesive")
    (34 "B.Paste" user)
    (35 "F.Paste" user)
    (36 "B.SilkS" user "B.Silkscreen")
    (37 "F.SilkS" user "F.Silkscreen")
    (38 "B.Mask" user "B.Mask")
    (39 "F.Mask" user "F.Mask")
    (40 "Dwgs.User" user "User.Drawings")
    (41 "Cmts.User" user "User.Comments")
    (42 "Eco1.User" user "User.Eco1")
    (43 "Eco2.User" user "User.Eco2")
    (44 "Edge.Cuts" user)
    (45 "Margin" user)
    (46 "B.CrtYd" user "B.Courtyard")
    (47 "F.CrtYd" user "F.Courtyard")
    (48 "B.Fab" user)
    (49 "F.Fab" user)
  )
  (setup
    (pad_to_mask_clearance 0)
  )
  (net 0 "")
  (net 1 "GND")
  (net 2 "+3V3")
  (net 3 "SDA")
  (net 4 "SCL")

  (gr_line (start 5 5) (end 95 5) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 95 5) (end 95 80) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 95 80) (end 5 80) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 5 80) (end 5 5) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))

  (footprint "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"
    (version 20260206)
    (layer "F.Cu")
    (uuid "{u()}")
    (at 80 20)
    (property "Reference" "U2" (at 0 -2.54 0) (layer "F.SilkS") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "SSD1306_OLED" (at 0 10.16 0) (layer "F.Fab") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Footprint" "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Datasheet" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Description" "SSD1306 OLED Display" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (fp_line (start -1.33 -1.33) (end 1.33 -1.33) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 1.33 -1.33) (end 1.33 8.95) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 1.33 8.95) (end -1.33 8.95) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start -1.33 8.95) (end -1.33 -1.33) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net 1 "GND") (uuid "{u()}"))
    (pad "2" thru_hole circle (at 0 2.54) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net 2 "+3V3") (uuid "{u()}"))
    (pad "3" thru_hole circle (at 0 5.08) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net 4 "SCL") (uuid "{u()}"))
    (pad "4" thru_hole circle (at 0 7.62) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net 3 "SDA") (uuid "{u()}"))
  )

  (segment (start 80 20) (end 85 20) (width 0.8) (layer "F.Cu") (net 1) (uuid "{u()}"))

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
      (pts
        (xy 5 5)
        (xy 95 5)
        (xy 95 80)
        (xy 5 80)
      )
    )
  )
)
"""

test_pcb.write_text(content, encoding="utf-8")

cmd = [
    r"C:\Users\moham\AppData\Local\Programs\KiCad\10.0\bin\kicad-cli.exe",
    "pcb",
    "drc",
    "--output",
    r"c:\Users\moham\Desktop\msrus\hardware\drc_test.rpt",
    str(test_pcb)
]

res = subprocess.run(cmd, capture_output=True, text=True)
print("Exit code:", res.returncode)
print("Stdout:", res.stdout)
print("Stderr:", res.stderr)

rpt = Path(r"c:\Users\moham\Desktop\msrus\hardware\drc_test.rpt")
if rpt.exists():
    print(rpt.read_text(encoding="utf-8"))
