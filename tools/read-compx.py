"""Read-only Compx identity and settings capture; never writes flash or switches profiles."""
import sys,pathlib,json,time,os,subprocess
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'.local-tools'))
import hid

# The parent never opens HID handles; it bounds the whole native worker, including writes/opens.
if '--worker' not in sys.argv:
 if len(sys.argv) < 3:raise SystemExit('Usage: read-compx.py output.json receiver_pid')
 child=subprocess.Popen([sys.executable,'-u',__file__,*sys.argv[1:],'--worker'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
 try:
  output,error=child.communicate(timeout=12)
  print(output,end='');print(error,end='',file=sys.stderr);raise SystemExit(child.returncode)
 except subprocess.TimeoutExpired:
  child.kill()
  try:child.communicate(timeout=3)
  except subprocess.TimeoutExpired:print('Native worker termination has not completed.',file=sys.stderr)
  raise SystemExit('Read-only probe exceeded 12 seconds; no further requests will be sent.')

def exchange(dev,command,fields={}):
 if command not in (1,3,8,4,0x0e,0x12,0x1d):raise RuntimeError('non-read command blocked')
 p=[0]*16;p[0]=command
 for i,v in fields.items():p[i]=v
 p[15]=(0x55-((8+sum(p[:15]))&255))&255
 dev.write([8]+p)
 until=time.monotonic()+2
 while time.monotonic()<until:
  raw=dev.read(64)
  if not raw:time.sleep(.01)
  if len(raw)>=17 and raw[0]==8:raw=raw[1:]
  if len(raw)>=16 and raw[0]==command:
   if ((8+sum(raw[:16]))&255)!=0x55:raise RuntimeError('reply checksum mismatch')
   if raw[1]!=0:raise RuntimeError('command %02x rejected: %s'%(command,raw[1]))
   return raw
 raise RuntimeError('command %02x timed out'%command)

found={}
target_pid = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x101b
for item in hid.enumerate(0x373b, target_pid):
 if item['usage_page'] == 0xff02 and item['usage']==2:
  key=(item['product_id'],item['product_string'])
  if key not in found or item['usage_page']==0xff02:found[key]=item
results=[]
for info in found.values():
 out={k:info[k] for k in ['vendor_id','product_id','product_string','usage_page','usage']};dev=hid.device()
 try:
  dev.open_path(info['path']);dev.set_nonblocking(1);identity=exchange(dev,1,{4:8,**dict(zip(range(5,9),os.urandom(4)))})
  out['identity']=identity;out['cid']=identity[9];out['mid']=identity[10];out['type']=identity[11]
  if (out['cid'],out['mid'])!=(2,87):raise RuntimeError('not A9 Ultra; refusing further queries')
  r=exchange(dev,3)
  out['control_reply']=r
  if r[9]==1:raise RuntimeError('receiver remains busy')
  if r[5]!=1:raise RuntimeError('mouse not awake')
  images=[]
  for _ in range(2):
   image=[]
   for address in range(0,185,10):
    count=min(10,185-address);r=exchange(dev,8,{2:address>>8,3:address&255,4:count});image+=r[5:5+count]
   images.append(bytes(image).hex())
  out['flash']=images[0];out['stable']=images[0]==images[1];out['extras']={}
  for cmd in [4,0x0e,0x12,0x1d]:
   try:out['extras'][hex(cmd)]=exchange(dev,cmd)
   except Exception as e:out['extras'][hex(cmd)]=str(e)
 except Exception as e:out['error']=str(e)
 finally:
  dev.close()
 results.append(out)
 print(json.dumps(out,ensure_ascii=False),flush=True)
text=json.dumps(results,ensure_ascii=False,indent=2)
if len(sys.argv)>1:pathlib.Path(sys.argv[1]).write_text(text,encoding='utf-8')
print(text)
