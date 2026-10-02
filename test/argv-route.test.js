'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { route, withAutoUpdateEnv } = require('../lib/argv-route');
const k = a => route(a).kind;
test('routes command basics and positional boundaries',()=>{
 assert.equal(k([]),'passthrough'); assert.equal(k(['models']),'passthrough');
 assert.equal(k(['update']),'update'); assert.equal(k(['upgrade','1.2.3']),'update');
 assert.equal(k(['uninstall']),'uninstall'); assert.equal(k(['--','uninstall']),'passthrough');
 assert.equal(k(['run','uninstall']),'passthrough');
});
test('known value flags consume their values',()=>{
 for(const a of [['--log-level','info','uninstall'],['--log-level=info','uninstall'],['--server','X','uninstall'],['-s','ID','uninstall'],['--completions','bash','uninstall'],['--prompt','hello','uninstall'],['--continue','uninstall'],['--auto','uninstall'],['--standalone','uninstall'],['--version','uninstall'],['-v','uninstall'],['-c','uninstall'],['--wizard','uninstall'],['--print-logs','uninstall']]) assert.equal(k(a),'uninstall',a.join(' '));
 assert.equal(k(['--log-level']),'passthrough');
 assert.equal(k(['--log-level','--print-logs','uninstall']),'uninstall');
 assert.equal(k(['--server','--','uninstall']),'passthrough');
 assert.equal(k(['-s=ID','uninstall']),'refuse'); assert.equal(k(['-s=ID','update']),'refuse');
 assert.equal(k(['--server','-','uninstall']),'uninstall');
});
test('boolean literals match exact lower-case vocabulary',()=>{
 for(const v of ['true','yes','on','1','y','false','no','off','0','n']) { assert.equal(k(['--print-logs',v,'uninstall']),'uninstall',v); assert.equal(k(['--print-logs='+v,'uninstall']),'uninstall',v); }
 for(const v of ['TRUE','False']) { assert.equal(k(['--print-logs',v,'uninstall']),'passthrough',v); assert.equal(k(['--print-logs='+v,'uninstall']),'uninstall',v); }
});
test('unknown flag is fail-closed and clustered flags stay unknown',()=>{
 assert.equal(k(['--mystery','uninstall']),'refuse'); assert.equal(k(['--mystery','update']),'refuse'); assert.equal(k(['--mystery','unrelated']),'passthrough');
 assert.equal(k(['-cs','ID','uninstall']),'refuse'); assert.equal(k(['--no-print-logs','uninstall']),'refuse');
});
test('help takes precedence for update route without evaluating values',()=>{for(const a of [['--help','update'],['--help=false','update'],['--help','false','update'],['-h','false','upgrade'],['--help=anything','upgrade']]) assert.equal(k(a),'help',a.join(' '));});
test('short equals, unknown value consumption and terminator behavior',()=>{assert.equal(k(['--unknown','--server','update']),'passthrough');assert.equal(k(['--unknown','value','update']),'refuse');assert.equal(k(['--unknown','--','update']),'passthrough');assert.equal(k(['--unknown','--server','update']),'passthrough');assert.equal(k(['--unknown','-h','update']),'refuse');});

test('automatic update env is added only when unset',()=>{
 assert.equal(withAutoUpdateEnv({}).OPENCODE_DISABLE_AUTOUPDATE,'1');
 for(const value of ['0','false','']) assert.equal(withAutoUpdateEnv({OPENCODE_DISABLE_AUTOUPDATE:value}).OPENCODE_DISABLE_AUTOUPDATE,value);
});

test('update arguments are preserved for wrapper routing and ordinary args stay intact',()=>{
 assert.deepEqual(route(['update','2.1.0','--help']),{kind:'update',rest:['2.1.0','--help']});
 assert.equal(k(['run','update']),'passthrough');
 const original=['models','--json'];
 assert.deepEqual(route(original),{kind:'passthrough',rest:[]});
 const env={PATH:'/bin',OPENCODE_DISABLE_AUTOUPDATE:'false',LD_PRELOAD:'',LD_LIBRARY_PATH:'/glibc'};
 assert.deepEqual(withAutoUpdateEnv(env),env);
});
