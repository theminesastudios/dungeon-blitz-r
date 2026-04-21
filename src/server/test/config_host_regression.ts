import { strict as assert } from 'assert';
import { normalizeHostValue } from '../core/config';

function testNormalizeHostValue(): void {
    assert.equal(
        normalizeHostValue('http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp', 'fallback'),
        'localhost'
    );
    assert.equal(normalizeHostValue('https://10.179.241.65/', 'fallback'), '10.179.241.65');
    assert.equal(normalizeHostValue('10.179.241.65:8000', 'fallback'), '10.179.241.65');
    assert.equal(normalizeHostValue('', 'fallback'), 'fallback');
}

function main(): void {
    testNormalizeHostValue();
    console.log('config_host_regression: ok');
}

main();
