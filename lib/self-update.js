'use strict';
const PACKAGE = '@bash0816/opencode-termux';
const REGISTRY = 'https://registry.npmjs.org';
const path = require('path');
function parseArgs(args) {
  if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) return { kind: 'help' };
  let version = null;
  for (const arg of args) {
    if (arg.startsWith('-')) return { kind: 'error', message: 'この方式には非対応です / This option is not supported.' };
    if (version !== null) return { kind: 'error', message: '余分な引数があります / Unexpected argument.' };
    version = arg;
  }
  if (version === null) return { kind: 'latest' };
  const m = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!m || m.slice(2).some(x => !Number.isSafeInteger(Number(x)))) return { kind: 'error', message: 'バージョン形式が不正です / Invalid version.' };
  return { kind: 'version', version: version.replace(/^v/, '') };
}
function compare(a, b) { const x=a.split('.').map(Number), y=b.split('.').map(Number); for(let i=0;i<3;i++) if(x[i]!==y[i]) return x[i]<y[i]?-1:1; return 0; }
function detectPrefix(realPath) {
  const parts = realPath.split('/').filter(Boolean), suffix = ['lib','node_modules','@bash0816','opencode-termux','lib'];
  if (parts.length <= suffix.length || !suffix.every((v,i)=>parts[parts.length-suffix.length+i]===v)) return null;
  return '/' + parts.slice(0,-suffix.length).join('/');
}
function detectInstallPrefix(fs = require('fs'), packageRoot = path.resolve(__dirname, '..'), libPath = __dirname) {
  const pkg = fs.realpathSync(packageRoot);
  const lib = fs.realpathSync(libPath);
  const ownPackage = fs.realpathSync(path.resolve(libPath, '..'));
  const fromPackage = detectPrefix(path.join(pkg, 'lib'));
  const fromOwnPackage = detectPrefix(path.join(ownPackage, 'lib'));
  const fromLib = detectPrefix(lib);
  return fromPackage && fromPackage === fromOwnPackage && fromOwnPackage === fromLib &&
    pkg === ownPackage && lib === path.join(pkg, 'lib') ? fromPackage : null;
}
function validVersion(v) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v);
  return !!m && m.slice(1).every(x => Number.isSafeInteger(Number(x)));
}
function registryGet(url, timeoutMs, https = require('https')) {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>req.destroy(new Error('request timeout')),timeoutMs);
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
    const req=https.get(url,res=>{ const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('error',e=>finish(reject,e)); res.on('aborted',()=>finish(reject,new Error('response aborted'))); res.on('end',()=>finish(resolve,{statusCode:res.statusCode,body:Buffer.concat(chunks).toString('utf8')})); });
    req.on('error',e=>finish(reject,e));
  });
}
async function runUpdate(args, deps) {
  const {write=()=>{},exit=()=>{},fs,registryGet:get=registryGet,spawnSync,currentVersion}=deps;
  const parsed=parseArgs(args);
  if(parsed.kind==='help'){write('Usage: opencode update [version]\n');exit(0);return;}
  if(parsed.kind==='error'){write(parsed.message+'\n');exit(2);return;}
  let prefix=null; try{prefix=detectInstallPrefix(fs, deps.packageRoot || path.resolve(__dirname, '..'), deps.libPath || __dirname);}catch(_){}
  if(!prefix){write('インストール先を特定できないため更新しません。`npm install -g --prefix <インストール時のprefix> @bash0816/opencode-termux@latest` を実行してください。\nCould not detect the installation prefix. Run `npm install -g --prefix <installation prefix> @bash0816/opencode-termux@latest`.\n');exit(1);return;}
  const requested=parsed.kind==='version'?parsed.version:'latest'; let meta;
  try{const res=await get(`${REGISTRY}/${PACKAGE.replace('/', '%2F')}/${requested}`,5000);if(res.statusCode!==200)throw Error('http');meta=JSON.parse(res.body);if(!meta||typeof meta.version!=='string'||!validVersion(meta.version))throw Error('version');if(parsed.kind==='version'&&meta.version!==parsed.version)throw Error('mismatch');}catch(_){write('npm registry から有効なバージョン情報を取得できませんでした。\nCould not retrieve valid version information from the npm registry.\n');exit(1);return;}
  const cmp=compare(meta.version,currentVersion);
  if(cmp===0){write(`Already on latest version: ${currentVersion}\n`);exit(0);return;}
  if(cmp<0&&parsed.kind!=='version'){write(`現在のバージョン ${currentVersion} は ${meta.version} より新しいため、変更しません。\nCurrent version ${currentVersion} is newer than ${meta.version}; no change made.\n`);exit(0);return;}
  const result=spawnSync('npm',['install','-g','--prefix',prefix,`${PACKAGE}@${meta.version}`],{stdio:'inherit'});
  if(result.error||result.signal||result.status===null){write('npm install を実行できませんでした。\nCould not run npm install.\n');exit(1);return;}
  if(result.status!==0){exit(result.status);return;}
  write('次回起動時に新しい OpenCode を取得します。\nThe new OpenCode binary will be fetched on the next launch.\n');exit(0);
}
function uninstallMessage(prefix) {
 const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
 const install=prefix?`npm uninstall -g --prefix ${quote(prefix)} ${PACKAGE}`:`npm uninstall -g --prefix <インストール時のprefix> ${PACKAGE}`;
 return 'このラッパー環境では opencode uninstall は対応していません。OpenCode のデータ・設定・認証・セッション・cache・state が削除される可能性があるため実行しません。\n削除するには `' + install + '` を実行し、キャッシュ `~/.opencode-termux` を削除してください。prefix を特定できない場合は <インストール時のprefix> を実際の prefix に置き換えてください。OpenCode 自身の設定・認証・セッションデータは削除されません(保存先は `opencode debug paths` で確認できます)。\n\nThe wrapper does not support opencode uninstall and will not run it because it may delete OpenCode data, settings, authentication, sessions, cache, and state.\nTo remove this wrapper, run `' + install + '` and delete `~/.opencode-termux`. If the prefix is unknown, replace <インストール時のprefix> with the prefix used during installation. OpenCode settings, authentication, and session data are retained; see `opencode debug paths` for their locations.\n';
}
module.exports={runUpdate,parseArgs,compare,detectPrefix,detectInstallPrefix,uninstallMessage,validVersion,registryGet,PACKAGE};
