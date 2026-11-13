const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const load = createRequire(path.join(process.cwd(), 'package.json'))('js-yaml').load
const root = __dirname
const repository = 'jonathanKingston/copse-release-rehearsal-20261107'
const tag = 'v0.0.6'
const realGh = execFileSync('which', ['gh'], { encoding: 'utf8' }).trim()
const events = []
const gh = (...args) => execFileSync(realGh, args, { encoding: 'utf8' }).trim()
const api = (endpoint, ...args) => gh('api', `repos/${repository}/${endpoint}`, ...args)
const json = (endpoint) => JSON.parse(api(endpoint))
const refs = (name) => {
  const result = spawnSync(realGh, ['api', `repos/${repository}/git/ref/tags/${name}`, '--jq', '.object.sha'], { encoding: 'utf8' })
  if (result.status === 0) return result.stdout.trim()
  if (result.stderr.includes('HTTP 404')) return null
  throw new Error(result.stderr)
}
const originalReleases = json('releases')
assert.ok(!originalReleases.some(r => r.tag_name === tag), 'probe release already exists')
assert.equal(refs(tag), null)
assert.equal(refs(`halted/${tag}`), null)
const originalLatest = json('releases/latest').tag_name
assert.equal(originalLatest, 'v0.0.3')
const object = json('git/ref/heads/main').object.sha
const conflictingObject = json(`commits/${object}`).parents[0].sha
assert.notEqual(object, conflictingObject)
const code = load(fs.readFileSync('.github/workflows/release-halt.yml', 'utf8')).jobs.change.steps.find(s => s.id === 'change').run
const visibility = code.slice(0, code.indexOf('\n{\n'))
assert.ok(visibility.includes('verify-restored') && visibility.endsWith('fi'))
fs.writeFileSync(path.join(root, 'visibility.sh'), visibility)
fs.writeFileSync(path.join(root, 'NON_INSTALLABLE_FIXTURE.txt'), 'NON-INSTALLABLE TEST FIXTURE. Disposable release recovery probe, 2026-11-13. Not a Copse download.\n')
fs.writeFileSync(path.join(root, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const repo = process.env.REHEARSAL_REPOSITORY
if (!(args[0] === 'api' && args.some(a => a.startsWith('repos/' + repo + '/'))) && !(args[0] === 'release' && args[args.indexOf('--repo') + 1] === repo)) throw new Error('non-rehearsal repository refused')
const mode = process.env.REHEARSAL_FAILURE
if (mode === 'archive' && args.includes('POST') && args.includes('ref=refs/tags/halted/' + process.env.TAG)) {
  process.stderr.write('injected archive creation failure\\n'); process.exit(1)
}
if (mode === 'withdraw' && args.includes('DELETE')) {
  process.stderr.write('injected tag withdrawal failure\\n'); process.exit(1)
}
if (mode === 'list' && args.includes('--paginate')) {
  const file = process.env.REHEARSAL_COUNTER
  const n = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '0') + 1
  fs.writeFileSync(file, String(n))
  if (n === 2) { process.stderr.write('injected post-publication list failure\\n'); process.exit(1) }
}
if (mode === 'latest' && args[0] === 'release' && args[2] === process.env.TAG && args.includes('--latest')) {
  process.stderr.write('injected latest selection failure\\n'); process.exit(1)
}
const result = spawnSync(process.env.REAL_GH, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`, { mode: 0o755 })
function run(action, failure = '') {
  const counter = path.join(root, 'counter')
  fs.rmSync(counter, { force: true })
  const result = spawnSync('bash', [path.join(root, 'visibility.sh')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, REAL_GH: realGh,
      RELEASE_REPOSITORY: repository, REHEARSAL_REPOSITORY: repository, TAG: tag, ACTION: action,
      RUNNER_TEMP: root, REHEARSAL_FAILURE: failure, REHEARSAL_COUNTER: counter },
  })
  events.push({ action, failure, exit: result.status, stdout: result.stdout, stderr: result.stderr })
  if (failure) {
    assert.equal(result.status, 1)
    assert.match(result.stderr, failure === 'unpublished' ? /has never been published/ : failure === 'ref-conflict' ? /differs from halted/ : /injected/)
  }
  else assert.equal(result.status, 0, result.stderr)
}
let releaseId
function snapshot() {
  const r = json(`releases/${releaseId}`)
  return { id: r.id, tag: r.tag_name, draft: r.draft, prerelease: r.prerelease, published_at: r.published_at,
    assets: r.assets.map(a => ({ id: a.id, name: a.name, size: a.size })),
    original: refs(tag), archive: refs(`halted/${tag}`), latest: json('releases/latest').tag_name }
}
const evidence = { date: '2026-11-13', source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), repository, tag, object, events, snapshots: {} }
try {
  api('git/refs', '--method', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${object}`)
  gh('release', 'create', tag, path.join(root, 'NON_INSTALLABLE_FIXTURE.txt'), '--repo', repository, '--verify-tag', '--draft', '--title', 'NON-INSTALLABLE recovery test fixture', '--notes', 'Disposable release recovery test. This text asset is not a Copse application, update, or download.')
  releaseId = json('releases').find(r => r.tag_name === tag).id
  const unpublished = snapshot()
  assert.equal(unpublished.published_at, null)
  run('halt', 'unpublished')
  run('resume', 'unpublished')
  assert.deepEqual(snapshot(), unpublished)
  evidence.snapshots.unpublished = unpublished
  gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--latest')
  const initial = snapshot()
  evidence.snapshots.initial = initial
  assert.equal(initial.latest, tag)
  run('halt', 'archive')
  const archiveFailure = snapshot()
  evidence.snapshots.archiveFailure = archiveFailure
  assert.equal(archiveFailure.draft, true)
  assert.equal(archiveFailure.original, object)
  assert.equal(archiveFailure.archive, null)
  assert.notEqual(archiveFailure.latest, tag)
  const assetUrl = `https://github.com/${repository}/releases/download/${tag}/NON_INSTALLABLE_FIXTURE.txt`
  const status = execFileSync('curl', ['-sSL', '-o', '/dev/null', '-w', '%{http_code}', assetUrl], { encoding: 'utf8' })
  assert.equal(status, '404', 'draft fixture asset should not be anonymously downloadable')
  evidence.partialHaltAnonymousAssetStatus = Number(status)
  run('halt')
  const halted = snapshot()
  evidence.snapshots.halted = halted
  assert.equal(halted.original, null)
  assert.equal(halted.archive, object)
  assert.equal(halted.latest, originalLatest)
  run('resume')
  run('halt', 'withdraw')
  const withdrawalFailure = snapshot()
  assert.equal(withdrawalFailure.draft, true)
  assert.equal(withdrawalFailure.latest, originalLatest)
  assert.equal(withdrawalFailure.original, object)
  assert.equal(withdrawalFailure.archive, object)
  evidence.snapshots.withdrawalFailure = withdrawalFailure
  run('halt')
  for (const failure of ['list', 'latest']) {
    if (failure === 'latest') run('halt')
    run('resume', failure)
    const partial = snapshot()
    evidence.snapshots[`partialResume_${failure}`] = partial
    assert.equal(partial.draft, false)
    assert.equal(partial.latest, originalLatest)
    assert.equal(partial.original, object)
    assert.equal(partial.archive, object)
    assert.deepEqual(partial.assets, initial.assets)
    run('resume')
    const completed = snapshot()
    evidence.snapshots[`completedResume_${failure}`] = completed
    assert.equal(completed.latest, tag)
    assert.equal(completed.published_at, partial.published_at)
    assert.deepEqual(completed.assets, initial.assets)
  }
  api(`git/refs/tags/halted/${tag}`, '--method', 'PATCH', '-f', `sha=${conflictingObject}`, '-F', 'force=true')
  run('halt', 'ref-conflict')
  const conflict = snapshot()
  assert.equal(conflict.draft, true)
  assert.equal(conflict.latest, originalLatest)
  assert.equal(conflict.original, object)
  assert.equal(conflict.archive, conflictingObject)
  evidence.snapshots.conflict = conflict
  api(`git/refs/tags/halted/${tag}`, '--method', 'PATCH', '-f', `sha=${object}`, '-F', 'force=true')
  run('halt')
  // Model the legacy halt layout while retaining the exact object in its original ref.
  execFileSync('bash', ['scripts/release-tag-state.sh', repository, tag, 'restore'], { encoding: 'utf8' })
  assert.equal(refs(tag), object)
  assert.equal(refs(`halted/${tag}`), object)
  api(`git/refs/tags/halted/${tag}`, '--method', 'DELETE')
  run('resume', 'list')
  const legacyPartial = snapshot()
  assert.equal(legacyPartial.archive, object)
  run('resume')
  const legacyCompleted = snapshot()
  assert.equal(legacyCompleted.latest, tag)
  assert.equal(legacyCompleted.published_at, legacyPartial.published_at)
  assert.deepEqual(legacyCompleted.assets, initial.assets)
  evidence.snapshots.legacyPartial = legacyPartial
  evidence.snapshots.legacyCompleted = legacyCompleted
  run('halt')
  evidence.snapshots.final = snapshot()
  assert.equal(evidence.snapshots.final.draft, true)
  assert.equal(evidence.snapshots.final.original, null)
  assert.equal(evidence.snapshots.final.archive, object)
  assert.equal(evidence.snapshots.final.latest, originalLatest)
  const stableFields = r => ({ id: r.id, tag: r.tag_name, draft: r.draft, prerelease: r.prerelease, published_at: r.published_at, assets: r.assets.map(a => ({ id:a.id, name:a.name, size:a.size })) })
  assert.deepEqual(json('releases').filter(r => r.tag_name !== tag).map(stableFields).sort((a,b) => a.id-b.id), originalReleases.map(stableFields).sort((a,b) => a.id-b.id))
  evidence.existingFixturesUnchanged = true
  evidence.productionTouched = false
  evidence.result = 'passed'
  console.log('PASS: unpublished drafts preserved; archive, withdrawal and conflict failures still restore stable fallback; partial-resume retries and legacy resume preserve exact refs, assets and publication time; prior latest restored.')
} catch (error) {
  evidence.result = 'failed'
  evidence.error = String(error)
  console.error(error)
  process.exitCode = 1
  if (releaseId) { try { run('halt'); evidence.cleanup = snapshot() } catch (cleanup) { evidence.cleanupError = String(cleanup) } }
} finally {
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
}
