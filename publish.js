#!/usr/bin/env node
/**
 * publish.js — pushes the collected clubs to GitHub Pages
 * =========================================================================
 * The daemon writes clubs.json next to index.html after every round. This
 * commits those two files and pushes them, so the public page shows the
 * current list. Nothing else in the repo is touched — it stages the two
 * files by name, never `git add .`.
 *
 *   node publish.js setup     turn on hourly publishing (once)
 *   node publish.js           publish now
 *   node publish.js status    configuration and last push
 *   node publish.js off       stop publishing (collection carries on)
 *
 * Once set up, the daemon calls this itself at the end of each round.
 *
 * Why GitHub Pages: free, the URL never expires, and the site stays up when
 * this machine is off. The machine only has to be on when the daemon runs.
 *
 * Node 18+. No dependencies. Needs git on PATH and push rights on the remote.
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT        = __dirname;
const SITE_JSON   = path.join(ROOT, 'clubs.json');
const APP_FILE    = path.join(ROOT, 'index.html');
const CONFIG_FILE = path.join(ROOT, 'publish.json');
const TRACKED     = ['clubs.json', 'index.html', '.nojekyll'];

/* ------------------------------------------------------------------ */
function readConfig(){
  if(!fs.existsSync(CONFIG_FILE)) return null;
  try{ return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); }
  catch(e){ console.error('publish.json is malformed: '+e.message); return null; }
}

function git(args){
  return execFileSync('git', args, {cwd:ROOT, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
}

function hasGit(){
  try{ execFileSync('git',['--version'],{stdio:'ignore'}); return true; }
  catch(e){ return false; }
}

function pagesUrl(remote, branch){
  const m = String(remote).match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/i);
  if(!m) return '';
  const [, user, repo] = m;
  // user.github.io repos publish at the root; everything else at /repo/
  return /^[^.]+\.github\.io$/i.test(repo)
    ? `https://${repo.toLowerCase()}/`
    : `https://${user.toLowerCase()}.github.io/${repo}/`;
}

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */
function setup(){
  if(!hasGit()){ console.error('\ngit is not installed, or not on PATH.\n'); process.exit(1); }

  let remote, branch;
  try{ remote = git(['remote','get-url','origin']); }
  catch(e){
    console.error(`\nThis folder has no "origin" remote, so there is nowhere to publish to.`);
    console.error(`Create a repository on GitHub and connect it:\n`);
    console.error(`  git remote add origin https://github.com/YOUR_USER/clubs-list.git\n`);
    process.exit(1);
  }
  try{ branch = git(['rev-parse','--abbrev-ref','HEAD']); }catch(e){ branch = 'main'; }

  // Publishing from a side branch is almost always a mistake: Pages serves one
  // branch, and hourly commits landing anywhere else are invisible.
  const arg = (process.argv[3]||'').trim();
  if(arg) branch = arg.replace(/^--branch=/,'');

  const url = pagesUrl(remote, branch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({remote, branch, url}, null, 2));

  console.log(`\n  Publishing is on.`);
  console.log(`    remote  ${remote}`);
  console.log(`    branch  ${branch}`);
  if(url) console.log(`    link    ${url}`);
  console.log(`\n  One thing left, on github.com:`);
  console.log(`    Settings -> Pages -> Source: "Deploy from a branch", branch "${branch}", folder "/ (root)".`);
  console.log(`\n  Then:  node publish.js`);
  console.log(`  After that the daemon pushes on its own, once an hour.\n`);
}

/* ------------------------------------------------------------------ *
 * publish
 * ------------------------------------------------------------------ */
function publish(quiet){
  const say = m => { if(!quiet) console.log(m); };
  const cfg = readConfig();

  if(!cfg){
    if(!quiet) console.error('\nNot set up yet. Run:  node publish.js setup\n');
    return false;
  }
  if(!hasGit()){
    if(!quiet) console.error('\ngit is not installed.\n');
    return false;
  }
  if(!fs.existsSync(SITE_JSON)){
    if(!quiet) console.error(`\nNo clubs.json yet. Run the daemon once first:  node daemon.js once\n`);
    return false;
  }

  let n = 0;
  try{ n = JSON.parse(fs.readFileSync(SITE_JSON,'utf8')).count || 0; }catch(e){}

  // .nojekyll keeps GitHub Pages from running the files through Jekyll
  const nj = path.join(ROOT, '.nojekyll');
  if(!fs.existsSync(nj)) fs.writeFileSync(nj, '');

  const staged = TRACKED.filter(f => fs.existsSync(path.join(ROOT, f)));

  try{
    git(['add','--'].concat(staged));

    // Only clubs.json changing with an unchanged count means the same clubs
    // and a new timestamp. Committing that would be an empty hourly commit
    // forever, so let git's own "nothing to commit" decide, and check the
    // staged diff first for the timestamp-only case.
    let diff = '';
    try{ diff = git(['diff','--cached','--name-only']); }catch(e){}
    if(!diff){ say('  Nothing changed since the last publish.'); return true; }

    try{
      git(['commit','-m',`clubs: ${n}`]);
    }catch(e){
      const out = String(e.stdout||'') + String(e.stderr||'');
      if(/nothing to commit/i.test(out)){ say('  Nothing to push.'); return true; }
      throw e;
    }
    // HEAD:branch, not just the branch name. The collector may well be
    // running from a worktree on some other branch; pushing "main" there
    // would push the local main ref, which has none of these commits, and
    // report success while the published page never changed.
    git(['push','origin', 'HEAD:'+cfg.branch]);
  }catch(e){
    const out = (String(e.stdout||'') + String(e.stderr||'')).trim();
    if(!quiet){
      console.error('\n  Push to GitHub failed:');
      console.error('  ' + (out.split('\n')[0] || e.message));
      if(/Authentication|could not read Username|Permission denied|publickey/i.test(out)){
        console.error('\n  That is authentication. Quickest fix: gh auth login');
        console.error('  Or add an SSH key to your GitHub account.');
      }
      if(/rejected|non-fast-forward|behind/i.test(out)){
        console.error('\n  The remote has commits this copy does not. Run: git pull --rebase');
      }
      console.error('');
    }
    return false;
  }

  say(`  Published ${n} clubs`);
  if(cfg.url) say(`    ${cfg.url}`);
  say(`    (Pages takes up to a minute to catch up)`);
  return true;
}

/* ------------------------------------------------------------------ *
 * status / off
 * ------------------------------------------------------------------ */
function status(){
  const cfg = readConfig();
  console.log('');
  if(!cfg){
    console.log('  Publishing: off');
    console.log('  Turn it on:  node publish.js setup');
    console.log('');
    return;
  }
  console.log('  remote  ' + cfg.remote);
  console.log('  branch  ' + cfg.branch);
  console.log('  link    ' + (cfg.url || '(not derived — see Settings -> Pages)'));

  if(fs.existsSync(SITE_JSON)){
    let d = {};
    try{ d = JSON.parse(fs.readFileSync(SITE_JSON,'utf8')); }catch(e){}
    console.log('  data    ' + (d.count||0) + ' clubs, generated ' + (d.generated||'?'));
  } else {
    console.log('  data    none yet — run the daemon first');
  }

  try{
    const last = git(['log','-1','--format=%h %ad %s','--date=short','--',...TRACKED]);
    console.log('  last    ' + (last || 'never published'));
  }catch(e){ console.log('  last    unknown'); }
  if(!fs.existsSync(APP_FILE)) console.log('  note    index.html is missing — the page would 404');
  console.log('');
}

function off(){
  if(fs.existsSync(CONFIG_FILE)){
    fs.unlinkSync(CONFIG_FILE);
    console.log('\n  Publishing off. Collection carries on; nothing more is pushed.\n');
  } else {
    console.log('\n  Publishing was already off.\n');
  }
}

/* ------------------------------------------------------------------ */
if(require.main === module){
  const cmd = process.argv[2] || 'publish';
  if(cmd === 'setup')       setup();
  else if(cmd === 'status') status();
  else if(cmd === 'off')    off();
  else if(cmd === 'quiet')  publish(true);
  else                      publish(false);
}

module.exports = { publish };
