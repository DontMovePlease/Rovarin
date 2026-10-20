'use strict';
// Explicit test preload only. Production never loads this file or mocks power APIs.
require('./system-management-test-tools');
const {EventEmitter}=require('events');
if(process.env.ROVARIN_REMOVAL_POLICY_TEST_DIRECTORY){
 const fs=require('fs'),path=require('path');
 require('../pin-manager').desktopTrust=async()=>{try{return fs.readFileSync(path.join(process.env.ROVARIN_REMOVAL_POLICY_TEST_DIRECTORY,'power-native-trust.bin'),'utf8');}catch{return null;}};
}
let executions=0;
function fakeSpawn(executable,args) {
 const proc=new EventEmitter();proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();proc.stdin=new EventEmitter();
 proc.stdin.end=value=>{if(value==='execute\n'){executions++;proc.stdout.emit('data',Buffer.from(JSON.stringify({state:'invoking'})+'\n'));setTimeout(()=>{proc.stdout.emit('data',Buffer.from(JSON.stringify({state:'initiated'})+'\n'));proc.emit('close',0);},40);}else proc.emit('close',1);};
 proc.kill=()=>proc.emit('close',1);
 setImmediate(()=>proc.stdout.emit('data',Buffer.from('{"state":"ready"}\n')));
 return proc;
}
const power=require('../power-controls'),Original=power.PowerControls;
power.PowerControls=class extends Original {constructor(){super({spawn:fakeSpawn,platform:'win32'});}};
module.exports={fakeSpawn,executions:()=>executions};
