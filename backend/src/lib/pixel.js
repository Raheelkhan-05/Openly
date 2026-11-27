// Builds the 1x1 transparent GIF. If a comment is given it is stored inside the image
// (a standard GIF comment block), so every tracking image served carries a quiet signature.
function buildPixel(comment) {
  const parts = [
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]), // 1x1, 2-colour table
    Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]), // colour table
  ];
  if (comment) {
    const c = Buffer.from(String(comment), 'latin1').subarray(0, 250);
    parts.push(Buffer.from([0x21, 0xfe, c.length]), c, Buffer.from([0x00]));
  }
  parts.push(
    Buffer.from([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00]), // transparent colour 0
    Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), // image
    Buffer.from([0x02, 0x01, 0x44, 0x00]), // pixel data
    Buffer.from([0x3b])
  );
  return Buffer.concat(parts);
}
module.exports = { buildPixel };
