import fs from 'fs';
export default class Files {
  read(name) { return fs.readFileSync('/srv/data/' + name, 'utf8'); } // expect: SEC-022
}
