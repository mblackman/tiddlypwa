import { assertEquals, assertRejects } from 'https://deno.land/std@0.192.0/testing/asserts.ts';

const encodingSource = Deno.readTextFileSync('./plugins/tiddlypwa/encoding.js');

Deno.test('decodeDataToBlob returns correct Blob for binary data', async () => {
    // Mock Blob and FileReader and TextEncoder/TextDecoder
    globalThis.Blob = class Blob {
        parts: any[];
        options: any;
        constructor(parts: any[], options: any) {
            this.parts = parts;
            this.options = options;
        }
    } as any;
    
    const _tw = { browser: true };
    const moduleFn = new Function('$tw', 'module', 'atob', encodingSource.replace('(function () {', '').replace('})();', ''));
    const module: any = { exports: {} };
    moduleFn(_tw, module, (s: string) => s);
    
    // Create a mock binary buffer
    // Flags: 1 (isBin)
    // Body length: 3
    // Body: [10, 20, 30]
    const buffer = new ArrayBuffer(5 + 3);
    const dw = new DataView(buffer);
    dw.setUint8(0, 1);
    dw.setUint32(1, 3);
    const ui8 = new Uint8Array(buffer);
    ui8.set([10, 20, 30], 5);

    const blob = await module.exports.decodeDataToBlob(buffer, 'image/png');
    assertEquals(blob.options.type, 'image/png');
    assertEquals(blob.parts[0].length, 3);
    assertEquals(blob.parts[0][0], 10);
});

Deno.test('decodeDataToBlob rejects gzipped data', async () => {
    const _tw = { browser: true };
    const moduleFn = new Function('$tw', 'module', 'atob', encodingSource.replace('(function () {', '').replace('})();', ''));
    const module: any = { exports: {} };
    moduleFn(_tw, module, (s: string) => s);
    
    // Flags: 2 (isGzipped)
    const buffer = new ArrayBuffer(5);
    const dw = new DataView(buffer);
    dw.setUint8(0, 2);

    await assertRejects(
        () => module.exports.decodeDataToBlob(buffer, 'text/plain'),
        Error,
        'unsupported binary encoding'
    );
});
