#!/usr/bin/env python3
r"""Generate complete KiCad 10.0 `.kicad_pcb` file for VitaWatch (JeevanCare).

Target: c:\Users\moham\Desktop\msrus\hardware\jeevancare.kicad_pcb
Board Size: 100mm x 70mm (dev prototype)
Layers: 2 layers (F.Cu and B.Cu)
Format: KiCad 10.0 S-expression
"""

import sys
import uuid
import subprocess
from pathlib import Path

OUTPUT_FILE = Path(r"c:\Users\moham\Desktop\msrus\hardware\jeevancare.kicad_pcb")

def u():
    return str(uuid.uuid4())

def f(val):
    s = f"{val:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s

NETS = [
    (0, ""),
    (1, "GND"),
    (2, "+3V3"),
    (3, "SDA"),
    (4, "SCL"),
    (5, "GPIO22"),
    (6, "GPIO21"),
    (7, "GPIO27"),
    (8, "GPIO4"),
    (9, "GPIO34"),
    (10, "GPIO33"),
    (11, "GPIO32"),
    (12, "R1_LED"),
]

def make_header_fp(ref, val, desc, num_pins, pos_x, pos_y, pin_net_map):
    fp_name = f"Connector_PinHeader_2.54mm:PinHeader_1x{num_pins:02d}_P2.54mm_Vertical"
    max_y_silk = (num_pins - 1) * 2.54 + 1.33

    pads = []
    for i in range(1, num_pins + 1):
        y_rel = (i - 1) * 2.54
        shape = "rect" if i == 1 else "circle"
        net_id = pin_net_map.get(i, 0)
        net_name = next(name for nid, name in NETS if nid == net_id)
        pads.append(
            f'    (pad "{i}" thru_hole {shape} (at 0 {f(y_rel)}) (size 1.7 1.7) (drill 1) '
            f'(layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {net_id} "{net_name}") (uuid "{u()}"))'
        )
    pads_str = "\n".join(pads)

    return f"""  (footprint "{fp_name}"
    (version 20260206)
    (layer "F.Cu")
    (uuid "{u()}")
    (at {f(pos_x)} {f(pos_y)})
    (property "Reference" "{ref}" (at 0 -2.54 0) (layer "F.SilkS") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "{val}" (at 0 {f(max_y_silk + 1.5)} 0) (layer "F.Fab") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Footprint" "{fp_name}" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Datasheet" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Description" "{desc}" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (fp_line (start -1.33 -1.33) (end 1.33 -1.33) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 1.33 -1.33) (end 1.33 {f(max_y_silk)}) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 1.33 {f(max_y_silk)}) (end -1.33 {f(max_y_silk)}) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start -1.33 {f(max_y_silk)}) (end -1.33 -1.33) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start -1.33 0) (end -2.0 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
{pads_str}
  )"""

def make_button_fp(ref, val, desc, pos_x, pos_y, p1_net, p2_net, angle=0):
    fp_name = "Button_Switch_THT:SW_PUSH_6mm"
    p1_name = next(name for nid, name in NETS if nid == p1_net)
    p2_name = next(name for nid, name in NETS if nid == p2_net)
    rot_str = f" {angle}" if angle != 0 else ""

    return f"""  (footprint "{fp_name}"
    (version 20260206)
    (layer "F.Cu")
    (uuid "{u()}")
    (at {f(pos_x)} {f(pos_y)}{rot_str})
    (property "Reference" "{ref}" (at 3.25 -2.5 0) (layer "F.SilkS") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "{val}" (at 3.25 7.0 0) (layer "F.Fab") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Footprint" "{fp_name}" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Datasheet" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Description" "{desc}" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (fp_line (start 0.5 -1.0) (end 6.0 -1.0) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 6.0 -1.0) (end 6.0 5.5) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 6.0 5.5) (end 0.5 5.5) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 0.5 5.5) (end 0.5 -1.0) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_circle (center 3.25 2.25) (end 4.75 2.25) (stroke (width 0.12) (type solid)) (fill none) (layer "F.SilkS") (uuid "{u()}"))
    (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1.1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {p1_net} "{p1_name}") (uuid "{u()}"))
    (pad "1" thru_hole circle (at 6.5 0) (size 2 2) (drill 1.1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {p1_net} "{p1_name}") (uuid "{u()}"))
    (pad "2" thru_hole circle (at 0 4.5) (size 2 2) (drill 1.1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {p2_net} "{p2_name}") (uuid "{u()}"))
    (pad "2" thru_hole circle (at 6.5 4.5) (size 2 2) (drill 1.1) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {p2_net} "{p2_name}") (uuid "{u()}"))
  )"""

def make_led_fp(ref, val, desc, pos_x, pos_y, p1_net, p2_net):
    fp_name = "LED_THT:LED_D3.0mm"
    p1_name = next(name for nid, name in NETS if nid == p1_net)
    p2_name = next(name for nid, name in NETS if nid == p2_net)

    return f"""  (footprint "{fp_name}"
    (version 20260206)
    (layer "F.Cu")
    (uuid "{u()}")
    (at {f(pos_x)} {f(pos_y)})
    (property "Reference" "{ref}" (at 1.27 -2.5 0) (layer "F.SilkS") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "{val}" (at 1.27 3.0 0) (layer "F.Fab") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Footprint" "{fp_name}" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Datasheet" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Description" "{desc}" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (fp_circle (center 1.27 0) (end 2.8 0) (stroke (width 0.12) (type solid)) (fill none) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 2.8 -1.1) (end 2.8 1.1) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (pad "1" thru_hole rect (at 0 0) (size 1.8 1.8) (drill 0.9) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {p1_net} "{p1_name}") (uuid "{u()}"))
    (pad "2" thru_hole circle (at 2.54 0) (size 1.8 1.8) (drill 0.9) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {p2_net} "{p2_name}") (uuid "{u()}"))
  )"""

def make_resistor_fp(ref, val, desc, pos_x, pos_y, p1_net, p2_net):
    fp_name = "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"
    p1_name = next(name for nid, name in NETS if nid == p1_net)
    p2_name = next(name for nid, name in NETS if nid == p2_net)

    return f"""  (footprint "{fp_name}"
    (version 20260206)
    (layer "F.Cu")
    (uuid "{u()}")
    (at {f(pos_x)} {f(pos_y)})
    (property "Reference" "{ref}" (at 3.81 -2.0 0) (layer "F.SilkS") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "{val}" (at 3.81 2.5 0) (layer "F.Fab") (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Footprint" "{fp_name}" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Datasheet" "" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Description" "{desc}" (at 0 0 0) (layer "F.Fab") hide (uuid "{u()}")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (fp_line (start 1.2 -1.25) (end 6.4 -1.25) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 6.4 -1.25) (end 6.4 1.25) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 6.4 1.25) (end 1.2 1.25) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (fp_line (start 1.2 1.25) (end 1.2 -1.25) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {p1_net} "{p1_name}") (uuid "{u()}"))
    (pad "2" thru_hole circle (at 7.62 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net {p2_net} "{p2_name}") (uuid "{u()}"))
  )"""

def seg(x1, y1, x2, y2, width, net_id, layer="F.Cu"):
    return f'  (segment (start {f(x1)} {f(y1)}) (end {f(x2)} {f(y2)}) (width {width}) (layer "{layer}") (net {net_id}) (uuid "{u()}"))'

def via(x, y, net_id, size=0.8, drill=0.4):
    return f'  (via (at {f(x)} {f(y)}) (size {size}) (drill {drill}) (layers "F.Cu" "B.Cu") (net {net_id}) (uuid "{u()}"))'

def generate_pcb():
    u1_l_nets = {1: 2, 5: 9, 7: 11, 8: 10, 11: 7, 14: 1}
    fp_u1_l = make_header_fp("U1_L", "ESP32_DevKit_Left", "ESP32 DevKit Left 19-pin header", 19, 35.0, 35.0, u1_l_nets)

    u1_r_nets = {1: 1, 3: 5, 6: 6, 7: 1, 8: 3, 9: 4, 13: 8}
    fp_u1_r = make_header_fp("U1_R", "ESP32_DevKit_Right", "ESP32 DevKit Right 19-pin header", 19, 60.4, 35.0, u1_r_nets)

    fp_u2 = make_header_fp("U2", "SSD1306_OLED", "0.96 inch I2C OLED Display", 4, 80.0, 20.0, {1: 1, 2: 2, 3: 4, 4: 3})
    fp_u3 = make_header_fp("U3", "MAX30102", "MAX30102 Pulse Oximeter & SpO2", 4, 80.0, 35.0, {1: 2, 2: 1, 3: 4, 4: 3})
    fp_u4 = make_header_fp("U4", "MAX30205", "MAX30205 Human Body Temperature Sensor", 4, 80.0, 50.0, {1: 2, 2: 1, 3: 4, 4: 3})
    fp_u5 = make_header_fp("U5", "DS3231_RTC", "DS3231 High Precision RTC Module", 4, 80.0, 65.0, {1: 2, 2: 1, 3: 4, 4: 3})

    fp_u6 = make_header_fp("U6", "DHT11", "DHT11 Temperature and Humidity Sensor", 3, 15.0, 20.0, {1: 2, 2: 8, 3: 1})
    fp_u7 = make_header_fp("U7", "AD8232_ECG", "AD8232 Single Lead Heart Rate Monitor", 6, 15.0, 40.0, {1: 1, 2: 2, 3: 9, 4: 10, 5: 11, 6: 2})

    fp_sw1 = make_button_fp("SW1", "Medicine_ACK", "Pushbutton SW_PUSH_6mm for Medicine ACK", 15.0, 62.0, 6, 1)
    fp_sw2 = make_button_fp("SW2", "Screen_Button", "Pushbutton SW_PUSH_6mm for Screen / 2nd ACK", 30.0, 62.0, 7, 1, angle=270)

    fp_d1 = make_led_fp("D1", "LED_Medicine", "3mm Red LED for Medicine Reminder", 48.0, 65.0, 12, 1)
    fp_r1 = make_resistor_fp("R1", "220R", "220 Ohm LED Current Limiting Resistor", 48.0, 58.0, 5, 12)
    fp_r2 = make_resistor_fp("R2", "4.7k", "4.7k Ohm DHT11 Data Pull-up Resistor", 15.0, 32.0, 2, 8)

    footprints = [fp_u1_l, fp_u1_r, fp_u2, fp_u3, fp_u4, fp_u5, fp_u6, fp_u7, fp_sw1, fp_sw2, fp_d1, fp_r1, fp_r2]

    segments = []
    vias = []

    # 1. I2C Bus: SDA (Net 3, 0.25mm)
    segments.append(seg(60.4, 52.78, 60.4, 53.0, 0.25, 3))
    segments.append(seg(60.4, 53.0, 73.0, 53.0, 0.25, 3))
    vias.append(via(73.0, 53.0, 3))
    segments.append(seg(73.0, 53.0, 75.5, 53.0, 0.25, 3, layer="B.Cu"))
    vias.append(via(75.5, 53.0, 3))
    segments.append(seg(75.5, 53.0, 77.0, 53.0, 0.25, 3))
    segments.append(seg(77.0, 27.62, 77.0, 72.62, 0.25, 3))
    segments.append(seg(77.0, 27.62, 80.0, 27.62, 0.25, 3))  # U2 pin 4
    segments.append(seg(77.0, 42.62, 80.0, 42.62, 0.25, 3))  # U3 pin 4
    segments.append(seg(77.0, 57.62, 80.0, 57.62, 0.25, 3))  # U4 pin 4
    segments.append(seg(77.0, 72.62, 80.0, 72.62, 0.25, 3))  # U5 pin 4

    # 2. I2C Bus: SCL (Net 4, 0.25mm)
    segments.append(seg(60.4, 55.32, 65.0, 55.32, 0.25, 4))
    vias.append(via(65.0, 55.32, 4))
    segments.append(seg(65.0, 55.32, 65.0, 50.0, 0.25, 4, layer="B.Cu"))
    vias.append(via(65.0, 50.0, 4))
    segments.append(seg(65.0, 50.0, 74.5, 50.0, 0.25, 4))
    segments.append(seg(74.5, 25.08, 74.5, 70.08, 0.25, 4))
    segments.append(seg(74.5, 25.08, 80.0, 25.08, 0.25, 4))  # U2 pin 3
    # Short B.Cu jumpers to cross SDA line cleanly at X=77:
    vias.append(via(76.0, 40.08, 4))
    segments.append(seg(74.5, 40.08, 76.0, 40.08, 0.25, 4))
    segments.append(seg(76.0, 40.08, 80.0, 40.08, 0.25, 4, layer="B.Cu"))

    vias.append(via(76.0, 55.08, 4))
    segments.append(seg(74.5, 55.08, 76.0, 55.08, 0.25, 4))
    segments.append(seg(76.0, 55.08, 80.0, 55.08, 0.25, 4, layer="B.Cu"))

    vias.append(via(76.0, 70.08, 4))
    segments.append(seg(74.5, 70.08, 76.0, 70.08, 0.25, 4))
    segments.append(seg(76.0, 70.08, 80.0, 70.08, 0.25, 4, layer="B.Cu"))

    # 3. Power: +3V3 (Net 2, 0.8mm)
    segments.append(seg(35.0, 35.0, 35.0, 14.0, 0.8, 2))
    segments.append(seg(10.0, 14.0, 85.0, 14.0, 0.8, 2))
    # Left power rail at X=10:
    segments.append(seg(10.0, 14.0, 10.0, 52.70, 0.8, 2))
    segments.append(seg(10.0, 20.0, 15.0, 20.0, 0.8, 2))       # U6 pin 1
    segments.append(seg(10.0, 32.0, 15.0, 32.0, 0.8, 2))       # R2 pin 1
    segments.append(seg(10.0, 42.54, 15.0, 42.54, 0.8, 2))     # U7 pin 2
    segments.append(seg(10.0, 52.70, 15.0, 52.70, 0.8, 2))     # U7 pin 6

    # Right power rail at X=85:
    segments.append(seg(85.0, 14.0, 85.0, 65.0, 0.8, 2))
    segments.append(seg(85.0, 22.54, 80.0, 22.54, 0.8, 2))     # U2 pin 2
    segments.append(seg(85.0, 35.0, 80.0, 35.0, 0.8, 2))       # U3 pin 1
    segments.append(seg(85.0, 50.0, 80.0, 50.0, 0.8, 2))       # U4 pin 1
    segments.append(seg(85.0, 65.0, 80.0, 65.0, 0.8, 2))       # U5 pin 1

    # 4. Ground: GND (Net 1, 0.8mm)
    # ESP32 U1_R pin 1 to top GND rail at Y=11 via B.Cu jumper over +3V3 line:
    segments.append(seg(60.4, 35.0, 60.4, 16.0, 0.8, 1))
    vias.append(via(60.4, 16.0, 1))
    segments.append(seg(60.4, 16.0, 60.4, 11.0, 0.8, 1, layer="B.Cu"))
    vias.append(via(60.4, 11.0, 1))
    segments.append(seg(60.4, 11.0, 88.0, 11.0, 0.8, 1))
    segments.append(seg(88.0, 11.0, 88.0, 67.54, 0.8, 1))

    # Right module GND connections via B.Cu:
    vias.append(via(87.0, 20.0, 1))
    segments.append(seg(88.0, 20.0, 87.0, 20.0, 0.8, 1))
    segments.append(seg(87.0, 20.0, 80.0, 20.0, 0.8, 1, layer="B.Cu"))  # U2 pin 1

    vias.append(via(87.0, 37.54, 1))
    segments.append(seg(88.0, 37.54, 87.0, 37.54, 0.8, 1))
    segments.append(seg(87.0, 37.54, 80.0, 37.54, 0.8, 1, layer="B.Cu")) # U3 pin 2

    vias.append(via(87.0, 52.54, 1))
    segments.append(seg(88.0, 52.54, 87.0, 52.54, 0.8, 1))
    segments.append(seg(87.0, 52.54, 80.0, 52.54, 0.8, 1, layer="B.Cu")) # U4 pin 2

    vias.append(via(87.0, 67.54, 1))
    segments.append(seg(88.0, 67.54, 87.0, 67.54, 0.8, 1))
    segments.append(seg(87.0, 67.54, 80.0, 67.54, 0.8, 1, layer="B.Cu")) # U5 pin 2

    # Bottom GND connections:
    # U1_L pin 14 (35, 68.02) to D1 cathode (50.54, 65):
    segments.append(seg(35.0, 68.02, 50.54, 68.02, 0.8, 1))
    segments.append(seg(50.54, 68.02, 50.54, 65.0, 0.8, 1))     # D1 cathode
    # U1_R GND connection:
    segments.append(seg(60.4, 50.24, 63.5, 50.24, 0.8, 1))
    segments.append(seg(63.5, 50.24, 63.5, 35.0, 0.8, 1))
    segments.append(seg(63.5, 35.0, 60.4, 35.0, 0.8, 1))

    # To SW2 and SW1 GND (routing at Y=70.5 to avoid SW2 pad 1):
    segments.append(seg(35.0, 68.02, 35.0, 70.5, 0.8, 1))
    segments.append(seg(35.0, 70.5, 25.5, 70.5, 0.8, 1))
    segments.append(seg(25.5, 70.5, 25.5, 68.5, 0.8, 1))       # SW2 pin 2b
    segments.append(seg(25.5, 68.5, 25.5, 62.0, 0.8, 1))       # SW2 pin 2a
    segments.append(seg(25.5, 66.5, 21.5, 66.5, 0.8, 1))       # SW1 pin 2b
    segments.append(seg(21.5, 66.5, 15.0, 66.5, 0.8, 1))       # SW1 pin 2a

    # 5. GPIO22 (Net 5, 0.5mm): U1_R pin 3 (60.4, 40.08) -> R1 pin 1 (48, 58)
    segments.append(seg(60.4, 40.08, 50.0, 40.08, 0.5, 5))
    segments.append(seg(50.0, 40.08, 50.0, 58.0, 0.5, 5))
    segments.append(seg(50.0, 58.0, 48.0, 58.0, 0.5, 5))

    # 6. R1_LED (Net 12, 0.5mm): R1 pin 2 (55.62, 58) -> D1 pin 1 (48, 65)
    segments.append(seg(55.62, 58.0, 55.62, 61.5, 0.5, 12))
    segments.append(seg(55.62, 61.5, 48.0, 61.5, 0.5, 12))
    segments.append(seg(48.0, 61.5, 48.0, 65.0, 0.5, 12))

    # 7. GPIO21 (Net 6, 0.5mm): U1_R pin 6 (60.4, 47.70) -> SW1 pin 1 (15, 62)
    # Via right at (54, 47.70) to B.Cu immediately:
    segments.append(seg(60.4, 47.70, 54.0, 47.70, 0.5, 6))
    vias.append(via(54.0, 47.70, 6))
    segments.append(seg(54.0, 47.70, 54.0, 29.0, 0.5, 6, layer="B.Cu"))
    segments.append(seg(54.0, 29.0, 7.5, 29.0, 0.5, 6, layer="B.Cu"))
    segments.append(seg(7.5, 29.0, 7.5, 62.0, 0.5, 6, layer="B.Cu"))
    vias.append(via(7.5, 62.0, 6))
    segments.append(seg(7.5, 62.0, 15.0, 62.0, 0.5, 6))        # SW1 pin 1a
    segments.append(seg(15.0, 62.0, 21.5, 62.0, 0.5, 6))       # SW1 pin 1b

    # 8. GPIO27 (Net 7, 0.5mm): U1_L pin 11 (35, 60.40) -> SW2 pin 1 (30, 62 & 30, 68.5)
    segments.append(seg(35.0, 60.40, 30.0, 60.40, 0.5, 7))
    segments.append(seg(30.0, 60.40, 30.0, 62.0, 0.5, 7))      # SW2 pin 1a
    segments.append(seg(30.0, 62.0, 30.0, 68.5, 0.5, 7))       # SW2 pin 1b

    # 9. GPIO4 (Net 8, 0.5mm): U1_R pin 13 (60.4, 65.48) -> DHT11 pin 2 (15, 22.54) & R2 pin 2 (22.62, 32)
    segments.append(seg(15.0, 22.54, 22.62, 22.54, 0.5, 8))
    segments.append(seg(22.62, 22.54, 22.62, 32.0, 0.5, 8))
    segments.append(seg(22.62, 32.0, 22.62, 26.0, 0.5, 8))
    vias.append(via(22.62, 26.0, 8))
    segments.append(seg(22.62, 26.0, 42.0, 26.0, 0.5, 8, layer="B.Cu"))
    segments.append(seg(42.0, 26.0, 42.0, 65.48, 0.5, 8, layer="B.Cu"))
    segments.append(seg(42.0, 65.48, 60.4, 65.48, 0.5, 8, layer="B.Cu"))

    # 10. GPIO34 (Net 9, 0.5mm): U1_L pin 5 (35, 45.16) -> AD8232 OUTPUT U7 pin 3 (15, 45.08)
    segments.append(seg(35.0, 45.16, 20.0, 45.16, 0.5, 9))
    segments.append(seg(20.0, 45.16, 20.0, 45.08, 0.5, 9))
    segments.append(seg(20.0, 45.08, 15.0, 45.08, 0.5, 9))

    # 11. GPIO32 (Net 11, 0.5mm): U1_L pin 7 (35, 50.24) -> AD8232 LO+ U7 pin 5 (15, 50.16)
    segments.append(seg(35.0, 50.24, 20.0, 50.24, 0.5, 11))
    segments.append(seg(20.0, 50.24, 20.0, 50.16, 0.5, 11))
    segments.append(seg(20.0, 50.16, 15.0, 50.16, 0.5, 11))

    # 12. GPIO33 (Net 10, 0.5mm): U1_L pin 8 (35, 52.78) -> AD8232 LO- U7 pin 4 (15, 47.62)
    segments.append(seg(35.0, 52.78, 27.0, 52.78, 0.5, 10))
    vias.append(via(27.0, 52.78, 10))
    segments.append(seg(27.0, 52.78, 20.0, 47.62, 0.5, 10, layer="B.Cu"))
    vias.append(via(20.0, 47.62, 10))
    segments.append(seg(20.0, 47.62, 15.0, 47.62, 0.5, 10))

    nets_str = "\n".join(f'  (net {nid} "{name}")' for nid, name in NETS)
    fps_str = "\n\n".join(footprints)
    segs_str = "\n".join(segments)
    vias_str = "\n".join(vias)

    content = f"""(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general
    (thickness 1.6)
    (legacy_teardrops no)
  )
  (paper "A4")
  (title_block
    (title "VitaWatch (JeevanCare) Health Monitoring Watch PCB")
    (date "2026-10-14")
    (rev "1.0")
    (company "JeevanCare")
    (comment 1 "Prototype/Development Board 100mm x 70mm")
  )
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
    (stackup
      (layer "F.SilkS" (type "Top Silk Screen"))
      (layer "F.Paste" (type "Top Solder Paste"))
      (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01) (material "Dry Film"))
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
      (layer "B.Cu" (type "copper") (thickness 0.035))
      (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01) (material "Dry Film"))
      (layer "B.Paste" (type "Bottom Solder Paste"))
      (layer "B.SilkS" (type "Bottom Silk Screen"))
      (copper_finish "None")
      (dielectric_constraints no)
    )
    (pad_to_mask_clearance 0)
  )

{nets_str}

  (gr_line (start 5 5) (end 95 5) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 95 5) (end 95 80) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 95 80) (end 5 80) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))
  (gr_line (start 5 80) (end 5 5) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "{u()}"))

  (gr_text "VitaWatch - JeevanCare" (at 50 8) (layer "F.SilkS") (uuid "{u()}")
    (effects (font (size 1.5 1.5) (thickness 0.3)))
  )
  (gr_text "ESP32 DevKit" (at 47.7 32) (layer "F.SilkS") (uuid "{u()}")
    (effects (font (size 1.2 1.2) (thickness 0.2)))
  )
  (gr_text "I2C Bus" (at 80 14) (layer "F.SilkS") (uuid "{u()}")
    (effects (font (size 1.2 1.2) (thickness 0.2)))
  )
  (gr_text "Rev 1.0" (at 88 77) (layer "F.SilkS") (uuid "{u()}")
    (effects (font (size 1 1) (thickness 0.15)) (justify right))
  )

{fps_str}

{segs_str}

{vias_str}

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

    OUTPUT_FILE.write_text(content, encoding="utf-8")
    print(f"Generated {OUTPUT_FILE} successfully ({len(content)} bytes).")

    # Pre-fill zones using KiCad python
    fill_script = f"""import pcbnew
b = pcbnew.LoadBoard(r'{OUTPUT_FILE}')
filler = pcbnew.ZONE_FILLER(b)
filler.Fill(b.Zones())
b.Save(r'{OUTPUT_FILE}')
print('Pre-filled zones in board file.')
"""
    try:
        subprocess.run(
            [r"C:\Users\moham\AppData\Local\Programs\KiCad\10.0\bin\python.exe", "-c", fill_script],
            capture_output=True, text=True, check=True
        )
        print("Zones pre-filled with pcbnew.")
    except Exception as e:
        print("Zone fill note:", e)

if __name__ == "__main__":
    generate_pcb()
