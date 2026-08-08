#!/usr/bin/env node
/**
 * publish.js — dá-te um link público sempre actualizado
 * =========================================================================
 * Pega no data/clubs-database.html gerado pelo daemon e publica-o num site
 * estático (GitHub Pages por omissão). O resultado é um URL permanente que
 * abres de qualquer sítio — telemóvel, outro computador, partilhar com
 * alguém — e que mostra sempre a última recolha.
 *
 *   node publish.js setup     configura, uma vez só
 *   node publish.js           publica agora
 *   node publish.js status    ver a configuração e o último envio
 *
 * Depois de configurado, o daemon publica sozinho no fim de cada ronda.
 *
 * Porquê GitHub Pages: é grátis, o URL não expira, e o site continua no ar
 * mesmo com o teu computador desligado (as páginas ficam alojadas no
 * GitHub, não em tua casa). Só precisas do computador ligado no momento
 * em que o daemon recolhe e envia.
 *
 * Node 18+. Sem dependências. Só precisa do git instalado.
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT        = process.cwd();
const DATA_DIR    = path.join(ROOT, 'data');
const SOURCE      = path.join(DATA_DIR, 'clubs-database.html');
const CONFIG_FILE = path.join(ROOT, 'publish.json');

/* ------------------------------------------------------------------ */
function readConfig(){
  if(!fs.existsSync(CONFIG_FILE)) return null;
  try{ return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); }
  catch(e){ console.error('publish.json está mal formado: '+e.message); return null; }
}

function git(args, cwd){
  return execFileSync('git', args, {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
}

function hasGit(){
  try{ execFileSync('git',['--version'],{stdio:'ignore'}); return true; }
  catch(e){ return false; }
}

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */
function setup(){
  const dir = process.argv[3];

  if(!dir){
    console.log(`
Configurar publicação — passos, uma vez só
==========================================

1. Cria um repositório novo no GitHub. Pode ser público ou privado; para
   GitHub Pages numa conta gratuita tem de ser público.
   Sugestão de nome: clubs-database

2. Clona-o para uma pasta à tua escolha:

     git clone https://github.com/O_TEU_USER/clubs-database.git ~/clubs-site

3. No GitHub, vai a Settings → Pages, e em "Source" escolhe
   "Deploy from a branch", branch "main", pasta "/ (root)". Grava.

4. Volta aqui e liga as duas coisas:

     node publish.js setup ~/clubs-site

A partir daí o daemon publica sozinho depois de cada ronda, e tens o link:

     https://O_TEU_USER.github.io/clubs-database/

Nota sobre autenticação: o push usa as credenciais de git que já tens. Se
nunca configuraste, o mais simples é o GitHub CLI (\`gh auth login\`) ou uma
chave SSH. Não guardo nem toco em passwords aqui.
`);
    return;
  }

  const abs = path.resolve(dir.replace(/^~/, process.env.HOME || '~'));

  if(!fs.existsSync(abs)){
    console.error(`\nA pasta ${abs} não existe. Clona o repositório primeiro (passo 2).\n`);
    process.exit(1);
  }
  if(!fs.existsSync(path.join(abs,'.git'))){
    console.error(`\n${abs} não é um repositório git. Usa a pasta que clonaste do GitHub.\n`);
    process.exit(1);
  }

  let remote = '', branch = 'main', url = '';
  try{ remote = git(['remote','get-url','origin'], abs); }
  catch(e){ console.error(`\n${abs} não tem um remote "origin". Falta clonar do GitHub.\n`); process.exit(1); }

  try{ branch = git(['rev-parse','--abbrev-ref','HEAD'], abs) || 'main'; }catch(e){}

  // deduzir o URL do Pages a partir do remote
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/i);
  if(m) url = `https://${m[1].toLowerCase()}.github.io/${m[2]}/`;

  fs.writeFileSync(CONFIG_FILE, JSON.stringify({dir:abs, branch, remote, url}, null, 2));

  console.log(`\n  ✓ Configurado`);
  console.log(`    pasta   ${abs}`);
  console.log(`    branch  ${branch}`);
  console.log(`    remote  ${remote}`);
  if(url) console.log(`    link    ${url}`);
  console.log(`\n  Testa já com:  node publish.js`);
  console.log(`  Depois é automático, no fim de cada ronda do daemon.\n`);
}

/* ------------------------------------------------------------------ *
 * publish
 * ------------------------------------------------------------------ */
function publish(quiet){
  const say = m => { if(!quiet) console.log(m); };

  const cfg = readConfig();
  if(!cfg){
    if(!quiet) console.error('\nAinda não está configurado. Corre:  node publish.js setup\n');
    return false;
  }
  if(!hasGit()){
    if(!quiet) console.error('\nO git não está instalado.\n');
    return false;
  }
  if(!fs.existsSync(SOURCE)){
    if(!quiet) console.error(`\nAinda não existe ${SOURCE}.\nCorre o daemon pelo menos uma vez primeiro.\n`);
    return false;
  }
  if(!fs.existsSync(cfg.dir)){
    if(!quiet) console.error(`\nA pasta ${cfg.dir} desapareceu. Corre o setup outra vez.\n`);
    return false;
  }

  const html = fs.readFileSync(SOURCE,'utf8');
  const target = path.join(cfg.dir, 'index.html');

  // Comparar ignorando o timestamp: ele muda em todas as rondas, e sem isto
  // ficávamos com um commit por hora mesmo sem clubes novos.
  const sansStamp = s => s.replace(/window\.__BAKED__="[^"]*";/, '');
  if(fs.existsSync(target) && sansStamp(fs.readFileSync(target,'utf8')) === sansStamp(html)){
    say('  Nada mudou desde a última publicação.');
    return true;
  }

  fs.writeFileSync(target, html);

  // .nojekyll evita que o GitHub Pages processe o ficheiro à sua maneira
  const nj = path.join(cfg.dir, '.nojekyll');
  if(!fs.existsSync(nj)) fs.writeFileSync(nj, '');

  // quantos clubes, para a mensagem do commit
  let n = 0;
  const m = html.match(/window\.__CLUBS__=(\[[\s\S]*?\]);window\.__BAKED__/);
  if(m){ try{ n = JSON.parse(m[1]).length; }catch(e){} }

  try{
    git(['add','index.html','.nojekyll'], cfg.dir);
    try{
      git(['commit','-m',`clubes: ${n}`], cfg.dir);
    }catch(e){
      const out = String(e.stdout||'') + String(e.stderr||'');
      if(/nothing to commit/i.test(out)){ say('  Nada para enviar.'); return true; }
      throw e;
    }
    git(['push','origin', cfg.branch], cfg.dir);
  }catch(e){
    const out = (String(e.stdout||'') + String(e.stderr||'')).trim();
    if(!quiet){
      console.error('\n  Falhou o envio para o GitHub:');
      console.error('  ' + (out.split('\n')[0] || e.message));
      if(/Authentication|could not read Username|Permission denied|publickey/i.test(out)){
        console.error('\n  É autenticação. O mais rápido é: gh auth login');
        console.error('  Ou configura uma chave SSH no GitHub.');
      }
      console.error('');
    }
    return false;
  }

  say(`  ✓ Publicados ${n} clubes`);
  if(cfg.url) say(`    ${cfg.url}`);
  say(`    (o GitHub Pages leva até um minuto a reflectir)`);
  return true;
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */
function status(){
  const cfg = readConfig();
  console.log('');
  if(!cfg){
    console.log('  Publicação: não configurada');
    console.log('  Para configurar:  node publish.js setup');
    console.log('');
    return;
  }
  console.log('  pasta   ' + cfg.dir);
  console.log('  branch  ' + cfg.branch);
  console.log('  link    ' + (cfg.url || '(não deduzido — vê nas Settings → Pages)'));

  const target = path.join(cfg.dir,'index.html');
  if(fs.existsSync(target)){
    const st = fs.statSync(target);
    console.log('  último  ' + st.mtime.toLocaleString());
  } else {
    console.log('  último  nunca publicado');
  }

  if(fs.existsSync(SOURCE)){
    const st = fs.statSync(SOURCE);
    console.log('  gerado  ' + st.mtime.toLocaleString());
  } else {
    console.log('  gerado  ainda não — corre o daemon primeiro');
  }
  console.log('');
}

/* ------------------------------------------------------------------ */
const cmd = process.argv[2] || 'publish';
if(cmd === 'setup')       setup();
else if(cmd === 'status') status();
else if(cmd === 'quiet')  publish(true);
else                      publish(false);

module.exports = { publish };
