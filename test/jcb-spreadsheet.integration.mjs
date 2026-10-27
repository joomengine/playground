import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { JCB_SOURCE_OVERLAY } from '../scripts/jcb-platform-overlay.mjs';
import { JCB_VENDOR_OVERLAYS } from '../scripts/jcb-vendor-overlay.mjs';
import { parseCatalog } from '../src/config.mjs';
import { loadBlueprintCatalog, resolveBlueprintConfiguration } from '../src/blueprints.mjs';

async function spreadsheetArchive(runtime) {
  let packageBytes;
  if (process.env.PLAYGROUND_JCB_PACKAGE) packageBytes = new Uint8Array(await readFile(process.env.PLAYGROUND_JCB_PACKAGE));
  else {
    const catalog = parseCatalog(runtime.manifest);
    const manifestURL = new URL('assets/manifest.json', runtime.assetBaseUrl);
    const blueprintCatalog = await loadBlueprintCatalog({ url: new URL(runtime.manifest.blueprints.url, manifestURL), fetcher: runtime.fetchAsset });
    const release = catalog.joomla.find((entry) => entry.version.startsWith('6.'));
    const { configuration } = await resolveBlueprintConfiguration({ blueprintId: 'jcb', joomlaVersion: release.version,
      phpVersion: runtime.phpVersion, admin: { password: `Unused-${crypto.randomUUID()}!` } },
    { catalog, blueprintCatalog, baseURL: runtime.assetBaseUrl, fetcher: runtime.fetchAsset });
    assert.equal(configuration.extensions.length, 1, 'The JCB recipe must identify its complete extension package.');
    const response = await runtime.fetchAsset(configuration.extensions[0].url);
    assert.equal(response.status, 200);
    packageBytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(packageBytes).digest('hex'), configuration.extensions[0].sha256);
  }
  const packages = unzipSync(packageBytes, { filter: (entry) => /joomla__Component-Builder__6\.x\.zip$/.test(entry.name) });
  assert.equal(Object.keys(packages).length, 1, 'The complete package must contain exactly one Joomla 6 component.');
  const prefix = 'component-builder/libraries/phpspreadsheet/vendor/';
  const files = unzipSync(Object.values(packages)[0], { filter: (entry) => entry.name.startsWith(prefix) || entry.name === JCB_SOURCE_OVERLAY.path });
  assert.equal(createHash('sha256').update(files[JCB_SOURCE_OVERLAY.path]).digest('hex'), JCB_SOURCE_OVERLAY.patchedSha256,
    'The tested package must contain the reviewed JCB reader compatibility declaration.');
  for (const overlay of JCB_VENDOR_OVERLAYS) {
    assert.equal(createHash('sha256').update(files[prefix + overlay.path]).digest('hex'), overlay.patchedSha256,
      `The tested package must contain the reviewed 32-bit packing correction: ${overlay.path}`);
  }
  const archive = {};
  for (const [name, bytes] of Object.entries(files)) {
    archive[name === JCB_SOURCE_OVERLAY.path ? 'jcb-chunk-read-filter.php' : `vendor/${name.slice(prefix.length)}`] = bytes;
  }
  assert.ok(archive['vendor/autoload.php']);
  assert.ok(archive['vendor/composer/platform_check.php'], 'The Composer platform guard must remain present.');
  return zipSync(archive);
}

for (const phpVersion of ['8.3', '8.4', '8.5']) {
  test(`PHP ${phpVersion}: maintained JCB spreadsheet dependencies write/read XLS and XLSX on wasm32`, { timeout: 180_000 }, async () => {
    const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion });
    try {
      await runtime.fs.writeFile('/tmp/spreadsheet-proof.zip', await spreadsheetArchive(runtime));
      const result = await runtime.runPhp(`<?php
        try {
            $zip = new ZipArchive();
            if ($zip->open('/tmp/spreadsheet-proof.zip') !== true || !$zip->extractTo('/tmp/spreadsheet-proof')) throw new RuntimeException('Cannot extract spreadsheet test dependencies.');
            $zip->close();
            require '/tmp/spreadsheet-proof/vendor/autoload.php';
            require '/tmp/spreadsheet-proof/jcb-chunk-read-filter.php';
            $filter = new VDM\\Joomla\\Import\\Spreadsheet\\ChunkReadFilter(1, 1);
            $results = [];
            foreach (['Xls', 'Xlsx'] as $format) {
                $book = new PhpOffice\\PhpSpreadsheet\\Spreadsheet();
                $sheet = $book->getActiveSheet();
                $sheet->setCellValue('A1', 'Joomla — erfgoed / Grüß');
                $sheet->setCellValueExplicit('B1', '00123', PhpOffice\\PhpSpreadsheet\\Cell\\DataType::TYPE_STRING);
                $sheet->setCellValue('C1', 123.5);
                $sheet->setCellValue('D1', '=C1*2');
                $sheet->setCellValue('F1', 4294967295.0);
                $sheet->setCellValue('A2', 'Outside the requested JCB chunk');
                $validation = $sheet->getCell('E1')->getDataValidation();
                $validation->setType(PhpOffice\\PhpSpreadsheet\\Cell\\DataValidation::TYPE_LIST);
                $validation->setFormula1('"red,blue"');
                $path = '/tmp/jcb-spreadsheet.' . strtolower($format);
                PhpOffice\\PhpSpreadsheet\\IOFactory::createWriter($book, $format)->save($path);
                $book->disconnectWorksheets();
                $reader = PhpOffice\\PhpSpreadsheet\\IOFactory::createReader($format);
                $reader->setReadFilter($filter);
                $loaded = $reader->load($path);
                $sheet = $loaded->getActiveSheet();
                $results[$format] = ['bytes' => filesize($path), 'text' => $sheet->getCell('A1')->getValue(),
                    'identifier' => $sheet->getCell('B1')->getValue(), 'number' => $sheet->getCell('C1')->getValue(),
                    'formula' => $sheet->getCell('D1')->getValue(), 'calculated' => $sheet->getCell('D1')->getCalculatedValue(),
                    'excluded' => $sheet->getCell('A2')->getValue(),
                    'validation' => $sheet->getCell('E1')->getDataValidation()->getType(),
                    'largeNumber' => $sheet->getCell('F1')->getValue()];
                $loaded->disconnectWorksheets();
            }
            $payload = str_repeat('JCB-large-OLE-', 700000);
            $oleFile = new PhpOffice\\PhpSpreadsheet\\Shared\\OLE\\PPS\\File(PhpOffice\\PhpSpreadsheet\\Shared\\OLE::ascToUcs('Payload'));
            $oleFile->append($payload);
            $oleRoot = new PhpOffice\\PhpSpreadsheet\\Shared\\OLE\\PPS\\Root(null, null, [$oleFile]);
            $handle = fopen('/tmp/jcb-large-ole.bin', 'w+b');
            $oleRoot->save($handle);
            fclose($handle);
            $oleReader = new PhpOffice\\PhpSpreadsheet\\Shared\\OLE();
            $oleReader->read('/tmp/jcb-large-ole.bin');
            $largeOle = false;
            foreach ($oleReader->_list as $index => $entry) {
                if ($entry->Type === PhpOffice\\PhpSpreadsheet\\Shared\\OLE::OLE_PPS_TYPE_FILE) {
                    $largeOle = $oleReader->getDataLength($index) === strlen($payload)
                        && hash('sha256', $oleReader->getData($index, 0, strlen($payload))) === hash('sha256', $payload);
                }
            }
            $numericBoundaries = [];
            foreach ([PHP_INT_MIN, PHP_INT_MAX, (float) PHP_INT_MIN - 1, (float) PHP_INT_MAX + 1, -11644473600.0] as $value) {
                $converted = PhpOffice\\PhpSpreadsheet\\Shared\\IntOrFloat::evaluate($value);
                $numericBoundaries[] = ['value' => $converted, 'type' => get_debug_type($converted)];
            }
            $nonFinite = [
                is_nan(PhpOffice\\PhpSpreadsheet\\Shared\\IntOrFloat::evaluate(NAN)),
                PhpOffice\\PhpSpreadsheet\\Shared\\IntOrFloat::evaluate(INF) === INF,
                PhpOffice\\PhpSpreadsheet\\Shared\\IntOrFloat::evaluate(-INF) === -INF,
            ];
            echo json_encode(['ok' => true, 'phpIntSize' => PHP_INT_SIZE,
                'spreadsheet' => Composer\\InstalledVersions::getPrettyVersion('phpoffice/phpspreadsheet'),
                'zipstream' => Composer\\InstalledVersions::getPrettyVersion('maennchen/zipstream-php'),
                'filterIncludesFirstRow' => $filter->readCell('A', 1), 'filterExcludesSecondRow' => !$filter->readCell('A', 2),
                'packing' => array_map(static fn (int $value): string => bin2hex(pack('V', $value)), [-1, -3, -4]),
                'largeOle' => $largeOle, 'numericBoundaries' => $numericBoundaries,
                'nonFinite' => $nonFinite, 'results' => $results], JSON_THROW_ON_ERROR);
        } catch (Throwable $error) { echo json_encode(['ok' => false, 'error' => $error->getMessage()], JSON_THROW_ON_ERROR); }
      `);
      assert.equal(result.status, 200, result.text);
      let proof;
      try { proof = JSON.parse(result.text); }
      catch { assert.fail(`The spreadsheet operation did not return clean JSON: ${result.text}`); }
      assert.equal(proof.ok, true, proof.error);
      assert.equal(proof.phpIntSize, 4, 'Compatibility must be proved on actual 32-bit PHP.');
      assert.equal(proof.spreadsheet, '3.10.8');
      assert.equal(proof.zipstream, '2.4.0');
      assert.equal(proof.filterIncludesFirstRow, true);
      assert.equal(proof.filterExcludesSecondRow, true);
      assert.deepEqual(proof.packing, ['ffffffff', 'fdffffff', 'fcffffff']);
      assert.equal(proof.largeOle, true, 'A large OLE container must preserve its complete stream across extra allocation sectors.');
      assert.deepEqual(proof.numericBoundaries, [
        { value: -2147483648, type: 'int' }, { value: 2147483647, type: 'int' },
        { value: -2147483649, type: 'float' }, { value: 2147483648, type: 'float' },
        { value: -11644473600, type: 'float' },
      ]);
      assert.deepEqual(proof.nonFinite, [true, true, true]);
      for (const format of ['Xls', 'Xlsx']) {
        assert.ok(proof.results[format].bytes > 100);
        assert.equal(proof.results[format].text, 'Joomla — erfgoed / Grüß');
        assert.equal(proof.results[format].identifier, '00123');
        assert.equal(proof.results[format].number, 123.5);
        assert.equal(proof.results[format].formula, '=C1*2');
        assert.equal(proof.results[format].calculated, 247);
        assert.equal(proof.results[format].excluded, null);
        assert.equal(proof.results[format].validation, 'list');
        assert.equal(proof.results[format].largeNumber, 4294967295);
      }
    } finally { await runtime.close(); }
  });
}
