"""Read-only V2 MCHOSE capture. Never sends configuration writes or profile switches."""
import sys, pathlib, json, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / '.local-tools'))
import hid

def query(device, report, command, count):
    previous = None
    for _ in range(20):
        body = [command ^ 255] + [255] * (count - 1) + [0] * (64 - count)
        device.send_feature_report([report] + body)
        time.sleep(.09)
        raw = device.get_feature_report(report, 65)
        if len(raw) < 3 or raw[1] ^ 255 != command:
            continue
        result = bytes(x ^ 255 for x in raw[2:])
        if result == previous and any(result[:11]):
            return result.hex()
        previous = result
    return None

results = []
for info in hid.enumerate(0x3837):
    if info['product_id'] not in (0x1001, 0x100b) or info['usage_page'] != 0xff01 or info['usage'] != 1:
        continue
    item = {k: info[k] for k in ('vendor_id', 'product_id', 'product_string', 'usage_page', 'usage')}
    device = hid.device()
    try:
        device.open_path(info['path'])
        item['reads'] = {hex(cmd): query(device, report, cmd, count) for report,cmd,count in
                         [(0x11,3,20),(0x11,4,20),(0x11,6,20),(0x12,0x67,64)]}
    except Exception as error:
        item['error'] = str(error)
    finally:
        device.close()
    results.append(item)
text = json.dumps(results, ensure_ascii=True, indent=2)
if len(sys.argv) > 1:
    pathlib.Path(sys.argv[1]).write_text(text, encoding='utf-8')
print(text)
