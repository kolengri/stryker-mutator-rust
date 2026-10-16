import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { analyze, loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'assignment-update.js', mutate = true) => ({ name, content, mutate });
const mappings = [
  ['+=', '-='], ['-=', '+='], ['*=', '/='], ['/=', '*='], ['%=', '*='],
  ['<<=', '>>='], ['>>=', '<<='], ['&=', '|='], ['|=', '&='],
  ['&&=', '||='], ['||=', '&&='], ['??=', '&&='],
];

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.deepEqual(actual.mutants, expected.mutants);
  return { actual, expected };
}

function execute(result, setup, observation, state, activeMutant, afterLoad, hitLimit) {
  const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    new vm.Script(`const events = []; ${setup}`).runInContext(context, { timeout: 1000 });
    for (const { content } of result.files) new vm.Script(content).runInContext(context, { timeout: 1000 });
    ns.currentTestId = 'assignment-test';
    if (afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    error = { name: caught.name, message: caught.message };
  }
  // All observers return data, never a function, receiver proxy, or Reference.
  const final = new vm.Script(state).runInContext(context, { timeout: 1000 });
  const events = new vm.Script('events').runInContext(context);
  return structuredClone({ value, error, final, events, ns });
}

function runtime(pair, setup, observation, state = 'null') {
  const baseline = execute(pair.actual, setup, observation, state);
  assert.equal(baseline.error, undefined, 'baseline observer must complete');
  const ids = [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)];
  for (const id of ids) for (const afterLoad of [false, true]) for (const hitLimit of [undefined, 0, 1]) {
    assert.deepEqual(
      execute(pair.actual, setup, observation, state, id, afterLoad, hitLimit),
      execute(pair.expected, setup, observation, state, id, afterLoad, hitLimit),
      `mutant ${id}, afterLoad=${afterLoad}, hitLimit=${hitLimit}`,
    );
  }
  return baseline;
}

for (const [operator, replacement] of mappings) {
  test(`native assignment exact mapping and runtime: ${operator}`, async () => {
    const pair = await compare([file(`function calc() { return a ${operator} rhs(); }`)]);
    const own = pair.actual.mutants.filter(m => m.mutatorName === 'AssignmentOperator');
    assert.equal(own.length, 1);
    assert.equal(own[0].replacement, `a ${replacement} rhs()`);
    runtime(pair, 'let a=12; function rhs(){events.push("rhs");return 2;}', '[calc(),calc(),typeof a]', 'a');
    runtime(pair, 'let a=BigInt(12); function rhs(){events.push("rhs");return BigInt(2);}', '[calc(),calc(),typeof a]', 'a');
  });
}

for (const operator of ['=', '**=', '>>>=', '^=']) {
  test(`unmapped assignment traverses descendants: ${operator}`, async () => {
    const pair = await compare([file(`function calc() { return obj[key.trim()] ${operator} rhs() + 1; }`)]);
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'AssignmentOperator'), false);
    assert.deepEqual(pair.actual.mutants.map(m => m.mutatorName), ['BlockStatement','MethodExpression','ArithmeticOperator']);
    runtime(pair, 'const key=" x "; const obj={x:4," x ":5}; function rhs(){events.push("rhs");return 2;}', '[calc(),calc()]', '[obj.x,obj[" x "]]');
  });
}

test('assignment string exclusion is direct and syntactic for all mappings', async () => {
  for (const [operator] of mappings) for (const rhs of ['"x"', '("x")', '`x`', '(`x`)', '`x${b + 1}`', '("x" + b)', '(`x` + b)']) {
    const pair = await compare([file(`function calc() { return a ${operator} ${rhs}; }`)]);
    const direct = ['"x"','("x")','`x`','(`x`)','`x${b + 1}`'].includes(rhs);
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'AssignmentOperator'), !direct || ['&&=','||=','??='].includes(operator), `${operator} ${rhs}`);
    runtime(pair, 'let a=6; const b=2;', '[calc(),calc(),typeof a]', 'a');
  }
  // No type inference: an Identifier with a string value still has a candidate.
  const pair = await compare([file('function calc(){return a += b;}')]);
  assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'AssignmentOperator'), true);
  runtime(pair, 'let a="a"; const b="b";', '[calc(),calc()]', 'a');
});

for (const operator of ['&&=', '||=', '??=']) {
  test(`logical assignment short-circuits with exact getter/key/RHS order: ${operator}`, async () => {
    const pair = await compare([file(`function calc(){ return factory()[key()] ${operator} rhs(); }`)]);
    for (const initial of ['false','0','""','null','undefined','7']) {
      const setup = `let stored=${initial}; const obj={get x(){events.push("get");return stored;},set x(v){events.push(["set",v]);stored=v;}};
        function factory(){events.push("factory");return obj;} function key(){events.push("key");return "x";} function rhs(){events.push("rhs");return 3;}`;
      runtime(pair, setup, '[calc(),calc(),typeof stored]', 'stored');
    }
  });
}

const targetSetup = `
  let a=5,b=3,index=0,stored=5;
  const key={name:"x",trim(){events.push("key.trim");return "x";},toString(){return "x";}};
  const rhs={value:2};
  const obj={get x(){events.push("get");return stored;},set x(v){events.push(["set",v]);stored=v;},0:4,1:7};
  const outer={inner:obj};
  function factory(){events.push("factory");return obj;}
  function getKey(){events.push("key");return "x";}
  function next(){events.push("rhs");return 2;}
`;
const assignmentCases = [
  ['identifier', 'a += next()'],
  ['static target', 'obj.x -= next()'],
  ['computed target', 'factory()[getKey()] *= next()'],
  ['nested members', 'outer.inner.x /= next()'],
  ['computed method key', 'obj[key.trim()] += next()'],
  ['computed literal key', 'obj["x"] += next()'],
  ['optional RHS', 'obj.x += rhs?.value'],
  ['optional computed key', 'obj[key?.name] += next()'],
  ['updated computed key', 'obj[index++] += next()'],
  ['nested RHS assignment', 'a += b *= next()'],
  ['nested inert assignment', 'a = b += next()'],
  ['assignment in target object', '(a = obj).x += next()'],
  ['nested computed assignment', 'obj[index = 0] += next()'],
];
for (const [name, expression] of assignmentCases) {
  test(`native assignment placement: ${name}`, async () => {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    runtime(pair, targetSetup, '[calc(),calc()]', '[typeof a === "object" ? "object" : a,b,index,stored,obj[0],obj[1]]');
  });
}

test('this-based public lvalues preserve their getter/setter receiver', async () => {
  for (const expression of ['this.x += next()', 'this[getKey()] ||= next()', 'this.x++', '--this[getKey()]']) {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    runtime(pair,targetSetup,'[calc.call(obj),calc.call(obj)]','stored');
  }
});

const spineSetup = `
  let first=5,second=9;
  const obj={get field(){events.push("get:original");return first;},set field(v){events.push(["set:original",v]);first=v;},
    trim(){events.push("trim");return trimmed;}};
  const trimmed={get field(){events.push("get:trimmed");return second;},set field(v){events.push(["set:trimmed",v]);second=v;}};
  const rhs={value:2}; function factory(){events.push("factory");return obj;}
`;

test('assignment object-spine mutations lift to the full assignment and snapshot the RHS', async () => {
  for (const operator of ['+=','=']) {
    const pair = await compare([file(`function calc(){return factory().trim().field ${operator} rhs?.value;}`)]);
    assert.deepEqual(pair.actual.mutants.map(m => m.mutatorName), operator === '+='
      ? ['BlockStatement','AssignmentOperator','MethodExpression','OptionalChaining']
      : ['BlockStatement','MethodExpression','OptionalChaining']);
    runtime(pair, spineSetup, '[calc(),calc()]', '[first,second]');
    assert.match(pair.actual.files[0].content, /\? \(factory\(\)\.field (?:\+=|=) rhs\?\.value\)/);
  }
  const pair = await compare([file('factory().trim().field += rhs?.value;')]);
  assert.deepEqual(pair.actual.mutants.map(({id,mutatorName,replacement}) => [id,mutatorName,replacement]), [
    ['0','AssignmentOperator','factory().trim().field -= rhs?.value'],
    ['1','MethodExpression','factory()'], ['2','OptionalChaining','rhs.value'],
  ]);
  runtime(pair, spineSetup, '0', '[first,second]');
});

for (const operator of ['++','--']) for (const prefix of [false,true]) {
  test(`native update preserves ${prefix ? 'prefix' : 'postfix'} ${operator}, ToNumeric and BigInt`, async () => {
    for (const target of ['a','obj.x','factory()[getKey()]','obj[key.trim()]','obj[index++]']) {
      const expression = prefix ? `${operator}${target}` : `${target}${operator}`;
      const pair = await compare([file(`function calc(){return ${expression};}`)]);
      assert.equal(pair.actual.mutants.find(m => m.mutatorName === 'UpdateOperator').replacement, prefix ? `${operator==='++'?'--':'++'}${target}` : `${target}${operator==='++'?'--':'++'}`);
      for (const initial of ['5','"5"','BigInt(5)','{valueOf(){events.push("valueOf");return 5;}}']) {
        const setup = `${targetSetup} a=${initial}; stored=${initial}; obj[0]=${initial}; obj[1]=${initial};`;
        const baseline = runtime(pair, setup, 'Array.from({length:2},()=>{const value=calc();return [value,typeof value];})', '[typeof a === "object" ? "object" : a,typeof stored === "object" ? "object" : stored,index,...[0,1,-1,-2].map(k=>typeof obj[k] === "object" ? "object" : obj[k])]');
        if (target === 'a' && initial === '5') {
          const delta = operator === '++' ? 1 : -1;
          assert.deepEqual(baseline.value, [[5+(prefix?delta:0),'number'],[5+(prefix?2*delta:delta),'number']]);
        }
      }
    }
  });
}

const orderExamples = [
  ['a += b+c;', [['0','AssignmentOperator','a -= b + c'],['1','ArithmeticOperator','b - c']]],
  ['obj[key.trim()] += x++;', [['0','AssignmentOperator','obj[key.trim()] -= x++'],['1','MethodExpression','key'],['2','UpdateOperator','x--']]],
  ['foo(a++);', [['1','UpdateOperator','a--']]],
  ['a = b+c;', [['0','ArithmeticOperator','b - c']]],
  ['obj.x = foo();', []],
  ['if(x++) foo();', [['0','ConditionalExpression','true'],['1','ConditionalExpression','false'],['2','UpdateOperator','x--'],['3','CallExpression',';']]],
  ['if(a += b) foo();', [['0','ConditionalExpression','true'],['1','ConditionalExpression','false'],['2','AssignmentOperator','a -= b'],['3','CallExpression',';']]],
];

test('preorder, conditional contexts and statement filters retain exact ID gaps', async () => {
  const setup = 'let a=5,b=2,c=1,x=3;const obj={x:4};const key="x";function foo(v){events.push(["foo",v]);}';
  for (const [content, records] of orderExamples) {
    const pair = await compare([file(content)]);
    assert.deepEqual(pair.actual.mutants.map(({id,mutatorName,replacement}) => [id,mutatorName,replacement]), records);
    runtime(pair, setup, 'events', '[a,b,x,obj.x]');
  }
  const pair = await compare([file('foo(a++);','first.js'),file('obj.x += b;','off.js',false),file('foo(a += b);','second.js'),file('foo();','last.js')]);
  assert.deepEqual(pair.actual.mutants.map(m => m.id), ['1','3','4']);
  runtime(pair, setup, 'events', '[a,b,x,obj.x]');
});

test('ranges, UTF16/CRLF locations, ignored candidates and explicit empty reasons', async () => {
  const setup = 'let a=5,b=2,x=4;const obj={x:6};function foo(v){events.push(v);}';
  for (const content of ['obj["x"] += a++;','if(a += b) foo(x++);','a += b + x;']) {
    for (const token of [content, '+=', 'a++', 'b + x', '"x"']) {
      const start = content.indexOf(token);
      if (start < 0) continue;
      const mutate = [{start:{line:0,column:start},end:{line:0,column:start+token.length}}];
      const pair = await compare([file(content,'ranges.js',mutate)]);
      runtime(pair, setup, 'events', '[a,b,x,obj.x]');
    }
  }
  const unicode = await compare([file('const emoji="😀";\r\na += b;\r\nx++;')]);
  assert.deepEqual(unicode.actual.mutants.map(m => m.location.start), [{line:0,column:12},{line:1,column:0},{line:2,column:0}]);
  runtime(unicode, setup, 'events', '[a,b,x]');
  for (const source of ['foo(a++);','foo(a += b);','a += b;','x++;','if(x++) foo(a += b);']) {
    for (const excludedMutations of [[],['AssignmentOperator'],['UpdateOperator'],['CallExpression'],['ConditionalExpression'],['AssignmentOperator','UpdateOperator','CallExpression','ConditionalExpression']]) {
      for (const directive of ['', '// Stryker disable next-line all: reason\n', '// Stryker disable next-line all:   \n', '// Stryker disable next-line CallExpression:   \n']) {
        const pair = await compare([file(directive + source)], {...options,excludedMutations});
        runtime(pair, setup, 'events', '[a,b,x]');
        if (pair.actual.mutants.every(m => m.status === 'Ignored')) assert.doesNotMatch(pair.actual.files[0].content,/function stryNS_/);
      }
    }
  }
});

test('assignment RHS direct eval and assignment callee retain value semantics', async () => {
  const evalPair = await compare([file('function calc(){let local=7;return a += eval("local");}')]);
  assert.deepEqual(runtime(evalPair, 'let a=1;', '[calc(),calc()]', 'a').value, [8,15]);
  const callPair = await compare([file('function calc(){return (a = obj.method)();}')]);
  const baseline = runtime(callPair, 'let a;const obj={method:function(){"use strict";events.push(this===undefined);return this===undefined;}};', '[calc(),calc()]', 'typeof a');
  assert.deepEqual(baseline.value, [true,true]);
});

test('anonymous arrow assignment keeps upstream names distinct from variable declarators', async () => {
  for (const content of ['a = x => x;','obj.x = x => x;','obj["x"] = x => x;','function calc(){return a = x => x;}']) {
    const pair = await compare([file(content)]);
    const baseline = runtime(pair, 'let a;const obj={};', content.startsWith('function') ? '[calc().name,a.name]' : '[a?.name,obj.x?.name]', '[typeof a,typeof obj.x]');
    const arrow = pair.actual.mutants.find(m => m.mutatorName === 'ArrowFunction');
    assert.ok(arrow);
    if (!content.startsWith('function')) assert.deepEqual(baseline.value, content.startsWith('a =') ? ['',undefined] : [undefined,'']);
  }
});

// Only caller-dependent stack tails differ between the two oracle invocations.
function diagnostic(error) {
  let callerTail = false;
  const message = error.message.split('\n').filter(line => {
    if (callerTail && /^\s+at /.test(line)) return false;
    callerTail = /^\s+at (?:async )?Instrumenter\.instrument /.test(line) && line.includes('/@stryker-mutator/instrumenter/dist/src/instrumenter.js:');
    return true;
  }).join('\n');
  return { name:error.name, message, cause:error.cause && diagnostic(error.cause) };
}

async function fallback(content, config = options, extension = 'js') {
  const files = [file('const first=true;','first.js'),file(content,`unsupported.${extension}`)];
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({files,options:config})));
  assert.equal(raw.supported,false,content);
  assert.equal(raw.result,undefined,content);
  await assert.rejects(createInstrumenter(logger,{cache:false,engine:'native'}).instrument(files,config),/unsupported/i,content);
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files,config); } catch(error) { failure = error; }
  const auto = createInstrumenter(logger,{cache:false,engine:'auto'});
  if (failure) await assert.rejects(auto.instrument(files,config), error => {assert.deepEqual(diagnostic(error),diagnostic(failure));return true;});
  else assert.deepEqual(await auto.instrument(files,config),expected,content);
  assert.equal(auto.stats.nativeBatches,0);
  assert.equal(auto.stats.fallbackBatches,1);
  return failure;
}

test('active update object-spine mutations reproduce upstream placement errors atomically', async () => {
  for (const content of ['factory().trim().field++;','++factory().trim().field;','factory().endsWith(x).field--;','if(factory().trim().field++) foo();']) {
    const failure = await fallback(content);
    assert.equal(failure.name,'SyntaxError');
    assert.match(failure.message,/UpdateExpression/);
    assert.match(failure.message,/ConditionalExpression/);
    assert.match(failure.message,/unsupported\.js/);
  }
  await fallback('// Stryker disable next-line MethodExpression:   \nfactory().trim().field++;');
  await fallback('factory().trim().field++;', {...options,excludedMutations:['UpdateOperator']});
});

test('update calls without pending mutations and excluded or out-of-range spine candidates stay native', async () => {
  const ordinary = await compare([file('function calc(){return factory().field++;}')]);
  runtime(ordinary,spineSetup,'[calc(),calc()]','[first,second]');
  for (const content of ['factory().trim().field++;','// Stryker disable next-line MethodExpression: reason\nfactory().trim().field++;']) {
    const pair = await compare([file(content)],{...options,excludedMutations:['MethodExpression']});
    assert.deepEqual(pair.actual.mutants.map(({id,mutatorName,status})=>[id,mutatorName,status]),[['0','UpdateOperator',undefined],['1','MethodExpression','Ignored']]);
    runtime(pair,spineSetup,'0','[first,second]');
  }
  const source='factory().trim().field++';
  const pair = await compare([file(source,'range.js',[{start:{line:0,column:17},end:{line:0,column:source.length}}])]);
  assert.deepEqual(pair.actual.mutants,[]);
  runtime(pair,spineSetup,'0','[first,second]');
});

test('optional computed keys and RHS keep independent short-circuit and update placements', async () => {
  for (const source of ['obj[key?.name]++','++obj[key?.name]','obj[index++] += rhs?.[index++]']) {
    const pair = await compare([file(`function calc(){return ${source};}`)]);
    for (const key of ['null','undefined','{name:"x"}']) for (const rhs of ['null','undefined','{1:2,3:4}']) {
      runtime(pair, `const obj={x:5,0:3,2:7};let index=0;const key=${key},rhs=${rhs};`, '[calc(),calc()]', '[obj.x,obj[0],obj[2],obj.undefined,index]');
    }
  }
});

test('nested and computed assignment spines replace exactly the intended call snapshot', async () => {
  const setup = spineSetup + 'trimmed.trim=function(){events.push("second trim");return this;};const key={name:"field"};';
  for (const source of ['factory().trim().trim().field += rhs?.value','factory().trim()[key?.name] += rhs?.value']) {
    const pair = await compare([file(`function calc(){return ${source};}`)]);
    runtime(pair,setup,'[calc(),calc()]','[first,second]');
  }
  for (const source of ['(a) += b','((obj.x))++','++(obj.x)']) {
    const pair = await compare([file(`function calc(){return ${source};}`)]);
    runtime(pair,'let a=4,b=2;const obj={x:5};','[calc(),calc()]','[a,obj.x]');
  }
});

test('unsupported targets and existing printer boundaries keep whole-batch fallback', async () => {
  for (const [content,extension='js'] of [
    ['[a] = list;'], ['({x:a} = obj);'], ['([a]=list,b++);'], ['for(let [i] of list) foo();'], ['a += 1n;'],
    ['class C extends B{f(){super.x += 1;}}'], ['class C{#x=0;f(){this.#x++;}}'],
    ['obj.x! += 1;','ts'], ['a += obj?.trim(...args);'], ['(obj?.x).field++;'],
    ['obj.x += ("single quoted" + a);'.replace('"single quoted"',"'single quoted'")],
    ['obj.x += ()=>1;'], ['factory().trim().field = x=>x;'], ['obj.x += {x:1};'],
    ['obj.x += [1,2,3];'], ['obj.x += 0x10;'], ['obj.x /* comment */ += 1;'],
  ]) await fallback(content,options,extension);
});

test('candidate preview remains experimental after sharing the assignment lookup', () => {
  for (const [operator,replacement] of mappings) {
    const result = analyze(`a ${operator} b;`);
    assert.equal(result.supported,false);
    assert.deepEqual(result.mutants.map(m=>[m.mutatorName,m.replacement]),[['AssignmentOperator',`a ${replacement} b`]]);
  }
});


test('all 17 registry mutators are accounted for at the accepted grammar boundary', async () => {
  const content = `function calc(){
    a=b+1; a=[]; a=x=>x; a=true; a=b===1; a=b&&1; a=obj.trim();
    a={x:1}; a="x"; a=-b; a=b++; a=obj?.x; a+=b; foo(b++); return typeof a;
  }`;
  const pair = await compare([file(content)]);
  assert.deepEqual([...new Set(pair.actual.mutants.map(m=>m.mutatorName))].sort(), [
    'ArithmeticOperator','ArrayDeclaration','ArrowFunction','BlockStatement','BooleanLiteral',
    'ConditionalExpression','EqualityOperator','LogicalOperator','MethodExpression','ObjectLiteral',
    'StringLiteral','UnaryOperator','UpdateOperator','OptionalChaining','AssignmentOperator',
  ].sort());
  // CallExpression's candidate is deliberately filtered by its Update descendant.
  const call = await compare([file('foo();')]);
  assert.deepEqual(call.actual.mutants.map(m=>m.mutatorName),['CallExpression']);
  runtime(pair, 'let a=0,b=2;const obj={x:4,trim(){events.push("trim");return 3;}};function foo(x){events.push(x);}', '[calc(),calc()]', '[typeof a,b]');
  // Regex is the only remaining registry member and is outside native grammar.
  await fallback('a = /abc/;');
});
