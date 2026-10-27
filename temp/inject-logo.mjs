import fs from 'node:fs';
const b64 = fs.readFileSync('src/web/frontend/public/logo-rounded.png').toString('base64');
const uri = 'data:image/png;base64,' + b64;
const files = process.argv.slice(2);
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes('__LOGO_DATA_URI__')) { console.log(f, ': no placeholder'); continue; }
  s = s.replace('__LOGO_DATA_URI__', uri);
  fs.writeFileSync(f, s);
  console.log(f, ': logo injected,', s.length, 'bytes');
}
