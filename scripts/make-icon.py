"""Generate PNG app art with only Python's standard library."""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
N = 1024

def segment_distance(x, y, x1, y1, x2, y2):
    vx, vy = x2-x1, y2-y1
    t = max(0.0, min(1.0, ((x-x1)*vx + (y-y1)*vy) / (vx*vx + vy*vy)))
    return math.hypot(x-x1-t*vx, y-y1-t*vy)

def png_chunk(kind, payload):
    return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)

raw = bytearray()
for y in range(N):
    raw.append(0)
    for x in range(N):
        qx, qy = abs(x-512)-307, abs(y-512)-307
        box_dist = math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - 145
        alpha = max(0.0, min(1.0, 0.5 - box_dist))
        arrow_dist = min(
            segment_distance(x, y, 310, 714, 708, 316),
            segment_distance(x, y, 480, 316, 708, 316),
            segment_distance(x, y, 708, 316, 708, 544)
        )
        white = max(0.0, min(1.0, 45.5-arrow_dist))
        mix = (x+y)/(2*N)
        base = (round(58-13*mix), round(113-31*mix), round(241-17*mix))
        raw.extend((round(base[0]*(1-white)+255*white), round(base[1]*(1-white)+255*white), round(base[2]*(1-white)+255*white), round(alpha*255)))
header = b'\x89PNG\r\n\x1a\n'
header += png_chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0))
header += png_chunk(b'IDAT', zlib.compress(raw, 8))
header += png_chunk(b'IEND', b'')
(ROOT / 'build' / 'icon.png').write_bytes(header)
