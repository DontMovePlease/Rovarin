'use strict';
// Exact accepted Linux candidate; additive to, never a substitute for Windows gates.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const archiveName='rovarin-0.6.0-linux-preview.tar.gz';
const accepted='ea969a5d94dea58f7e5d3e0a32fc048589e4f1d7ab811f19ec18b12ac3a47dcb';
const sourceFiles=['linux/linux-auth.js','linux/linux-metrics.js','linux/linux-processes.js','linux/platform.js','linux/rovarin.js','linux/server-linux.js','linux/README.md','linux/PREVIEW-README.md','test-support/http-contract.js','test-support/http-contract-smoke-test.js','test-support/README.md'];
const names=version=>version==='0.6.0'?[archiveName,archiveName+'.sha256']:[];
function verify(root,version){
  if(!names(version).length)return [];
  const assets=names(version).map(n=>path.join(root,'dist/linux-preview',n));
  for(const file of assets){if(fs.realpathSync(file)!==path.resolve(file)||!fs.lstatSync(file).isFile())throw Error('Unsafe Linux asset');}
  const bytes=fs.readFileSync(assets[0]);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  if(hash!==accepted||fs.readFileSync(assets[1],'utf8').trim()!==accepted+'  '+archiveName)throw Error('Accepted Linux archive/checksum changed');
  const tar=zlib.gunzipSync(bytes);let count=0;
  for(let offset=0;offset+512<=tar.length&&tar[offset];){
    const header=tar.subarray(offset,offset+512),name=header.subarray(0,100).toString().split('\0')[0];
    const size=parseInt(header.subarray(124,136).toString(),8),relative=name.slice('rovarin-0.6.0-linux-preview/'.length);
    if(relative!=='preview-manifest.json'){
      const file=path.join(root,relative==='README.md'?'linux/PREVIEW-README.md':relative);
      if(fs.realpathSync(file)!==path.resolve(file)||!fs.readFileSync(file).equals(tar.subarray(offset+512,offset+512+size)))throw Error('Linux archive/source mismatch: '+relative);
    }
    count++;offset+=512+Math.ceil(size/512)*512;
  }
  if(count!==37)throw Error('Unexpected accepted Linux inventory');
  return assets;
}
module.exports={archiveName,accepted,sourceFiles,names,verify};
