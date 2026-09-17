"""Prepare compact, attributed modern geography for the atlas.

Inputs: Natural Earth populated places / admin-1 GeoJSON and DataV China
province GeoJSON. Original downloads stay outside the checkout.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'public' / 'data'
BOUNDARIES = ROOT / 'boundaries'
BOUNDARIES.mkdir(exist_ok=True)
COUNTRY_CODES = {'SAH':'ESH','PSX':'PSE','SDS':'SSD'}

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')))

def simplify(points, tolerance):
    if len(points) < 6:
        return points
    a, b = points[0], points[-1]
    dx, dy = b[0]-a[0], b[1]-a[1]
    length = dx*dx+dy*dy
    best, index = 0, 0
    for i, p in enumerate(points[1:-1], 1):
        t = max(0, min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) if length else 0
        distance = (p[0]-a[0]-t*dx)**2+(p[1]-a[1]-t*dy)**2
        if distance > best:
            best, index = distance, i
    if best > tolerance*tolerance:
        return simplify(points[:index+1], tolerance)[:-1]+simplify(points[index:], tolerance)
    return [a, b]

def geometry(value, tolerance=.012):
    def ring(points):
        rounded = [[round(p[0], 4), round(p[1], 4)] for p in points]
        small = simplify(rounded, tolerance)
        return small if len(small) >= 4 else rounded
    if value['type'] == 'Polygon':
        coords = [ring(r) for r in value['coordinates']]
    else:
        coords = [[ring(r) for r in poly] for poly in value['coordinates']]
    return {'type':value['type'], 'coordinates':coords}

def collection(features, source, url, label):
    return {'features':features,'source':source,'sourceUrl':url,'label':label}

natural = json.load(open('/tmp/atlas-admin1.geojson'))['features']
grouped = {}
for f in natural:
    p = f['properties']; code = COUNTRY_CODES.get(p['adm0_a3'],p['adm0_a3'])
    if code in ['CHN','TWN','HKG','MAC']:
        continue
    item = {'type':'Feature','properties':{'id':p['adm1_code'],'name':p.get('name_zh') or p['name'],'english':p['name'],'country':code,'level':'1'},'geometry':geometry(f['geometry'])}
    grouped.setdefault(code, []).append(item)
for code, features in grouped.items():
    write(BOUNDARIES / (code+'.json'), collection(features,'Natural Earth','https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-1-states-provinces/','省／州级行政区'))

provinces = [f for f in json.load(open('/tmp/atlas-china-provinces.json'))['features'] if f['properties']['name']]
def china_feature(f):
    p=f['properties']
    return {'type':'Feature','properties':{'id':str(p['adcode']),'name':p['name'],'country':'CHN','level':'1'},'geometry':geometry(f['geometry'])}
write(BOUNDARIES/'CHN.json',collection([china_feature(f) for f in provinces],'DataV.GeoAtlas','https://datav.aliyun.com/tools/atlas/','省级行政区'))


cities=[]
for f in json.load(open('/tmp/atlas-populated-places.geojson'))['features']:
    p=f['properties']; code=COUNTRY_CODES.get(p['ADM0_A3'],p['ADM0_A3']); code='CHN' if code in ['TWN','HKG','MAC'] else code
    lng,lat=f['geometry']['coordinates']
    cities.append({'id':str(p['NE_ID']),'name':p.get('NAME_ZH') or p['NAME'],'country':code,'lat':round(lat,4),'lng':round(lng,4),'rank':p['SCALERANK'],'capital':bool(p['ADM0CAP'] and not (code=='CHN' and p['ADM0_A3']!='CHN')),'population':p['POP_MAX']})
cities.sort(key=lambda c:(not c['capital'],c['rank'],-c['population']))
write(ROOT/'cities.json',cities)
print('Prepared',len(cities),'cities and',len(grouped)+1,'country boundary files')
