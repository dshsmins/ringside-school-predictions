import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);let ts;
try{ts=require('typescript')}catch{ts=require('/opt/homebrew/lib/node_modules/firebase-tools/node_modules/typescript/lib/typescript.js')}
fs.mkdirSync('public',{recursive:true});
for(const [src,dest] of [['src/App.tsx','public/App.js'],['src/model.ts','public/model.js'],['src/AdminEditor.tsx','public/AdminEditor.js']]){const result=ts.transpileModule(fs.readFileSync(src,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true,fileName:src});const errs=(result.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error);if(errs.length)throw new Error(errs.map(x=>ts.flattenDiagnosticMessageText(x.messageText,'\n')).join('\n'));fs.writeFileSync(dest,result.outputText)}
console.log('Built static Firebase app; no package download required in this environment.');
