import assert from 'node:assert/strict';

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const listeners = [];
const extensionId = 'test-hstry-batch';
const chatId = '6addfdd2-81e0-83eb-b37c-97d7b316d6b8';
const chatUrl = 'https://chatgpt.com/c/' + chatId;
const store = { settings: { port: 41770, token: '', providers: { chatgpt: true } },
  status: { chatgpt: { state: {} } }, liveCaptureQueue: {} };
let writes = 0, failNext = false, releaseWrite = null, blockNext = false, remoteCalls = 0;
const copy = value => structuredClone(value);
const add = name => ({ addListener: fn => {
  if(name === 'message') listeners.push(fn);
} });
globalThis.chrome = {
  runtime: { id: extensionId, getManifest: () => ({ version: '0.4.44' }),
    onMessage: add('message'), onInstalled: add('installed'), onStartup: add('startup') },
  storage: {
    local: {
      get: async key => typeof key === 'string' ? { [key]: copy(store[key]) } : copy(store),
      set: async values => {
        if(Object.hasOwn(values,'liveCaptureQueue')) {
          writes++;
          if(failNext) { failNext = false; throw Error('fixture disk write failed'); }
          if(blockNext) {
            blockNext = false;
            await new Promise(resolve => { releaseWrite = resolve; });
          }
        }
        Object.assign(store, copy(values));
      },
      remove: async key => { delete store[key]; },
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
  alarms: { onAlarm: add('alarm'), getAll: async () => [],
    get: async () => null, create: async () => {} },
  action: { onClicked: add('clicked'), setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {} },
  tabs: { onUpdated: add('updated'), onActivated: add('activated'),
    onRemoved: add('removed'), query: async () => [] },
  scripting: { executeScript: async () => [] },
};
globalThis.fetch = async () => { remoteCalls++; throw Error('No requests expected in capture durability test'); };
const sender = { id: extensionId, frameId: 0, tab: { url: chatUrl } };
const valid = n => ({ conversationId: chatId, projectId: null, url: chatUrl,
  messageId: '00000000-0000-0000-0000-' + String(n).padStart(12,'0'),
  role: 'user', content: 'record ' + n, title: 'fixture' });
let observedResponses = 0;
function send(message, source = sender) {
  return new Promise((resolve,reject) => {
    let dispatched = false;
    for(const fn of listeners) {
      const async = fn(message,source,response => {observedResponses++;resolve(response)});
      if(async === true) dispatched = true;
    }
    if(!dispatched) reject(Error('message was not handled'));
  });
}
try {
  await import('../background.js');
  const old = await send({type:'hstryLiveCapture', capture:valid(1)});
  assert.equal(old.ok,true,'old tabs still use the supported single capture protocol');
  assert.equal(Object.keys(store.liveCaptureQueue).length,1);
  assert.equal(writes,1);

  const broken = await send({type:'hstryLiveCaptureBatch',
    captures:[valid(2),{...valid(3),messageId:'bad'}]});
  assert.equal(broken.ok,false,'invalid batch fails atomically');
  assert.equal(writes,1,'invalid batch did not touch durable storage');
  assert.equal(Object.keys(store.liveCaptureQueue).length,1);

  const tooLarge = await send({type:'hstryLiveCaptureBatch',
    captures:Array.from({length:26},(_,i)=>valid(i+2))});
  assert.equal(tooLarge.ok,false,'batch size is bounded');
  assert.equal(writes,1);

  const group=Array.from({length:25},(_,i)=>valid(i+2));
  const sent=await send({type:'hstryLiveCaptureBatch',captures:group});
  assert.equal(sent.ok,true);
  assert.equal(Object.keys(store.liveCaptureQueue).length,26);
  assert.equal(writes,2,'25 new captures cost one durable queue write');
  assert.equal(remoteCalls,0,'capture queue makes no ChatGPT requests');

  blockNext = true;
  let responded = false;
  const pending = send({type:'hstryLiveCaptureBatch',captures:[valid(27),valid(28)]})
    .then(x=>{responded=true;return x});
  for(let i=0;i<100 && !releaseWrite;i++)await new Promise(r=>setImmediate(r));
  assert.equal(responded,false,'never ACK before durable write finishes');
  assert.equal(Object.keys(store.liveCaptureQueue).length,26,'uncommitted captures remain queued in page');
  assert.equal(typeof releaseWrite,'function');
  releaseWrite();
  const after=await pending;
  assert.equal(after.ok,true);
  assert.equal(Object.keys(store.liveCaptureQueue).length,28);
  assert.equal(writes,3);

  failNext = true;
  const badWrite=await send({type:'hstryLiveCaptureBatch',captures:[valid(29),valid(30)]});
  assert.equal(badWrite.ok,false,'failed storage cannot ACK captures');
  assert.equal(Object.keys(store.liveCaptureQueue).length,28,'failed writes are not stored');
  assert.equal(remoteCalls,0);

  const dup={...valid(31),content:'newer revision'};
  const edited=await send({type:'hstryLiveCaptureBatch',captures:[valid(31),dup]});
  assert.equal(edited.ok,true);
  assert.equal(store.liveCaptureQueue[chatId+':'+dup.messageId].content,'newer revision',
    'last captured revision wins within durable batch');
  assert.equal(writes,5,'one extra write for each committed batch');
  assert.equal(remoteCalls,0);

  const repeat = Array.from({length:25},(_,i)=>valid(i+100));
  store.liveCaptureQueue = {};
  writes=0;
  for(const capture of repeat) assert.equal((await send({type:'hstryLiveCapture',capture})).ok,true);
  assert.equal(writes,25,'legacy single-message protocol writes 25 queue snapshots');
  assert.equal(Object.keys(store.liveCaptureQueue).length,25);
  store.liveCaptureQueue = {};
  writes=0;
  const batched = await send({type:'hstryLiveCaptureBatch',captures:repeat});
  assert.equal(batched.ok,true);
  assert.equal(writes,1,'identical 25-capture workload writes only one queue snapshot');
  assert.equal(Object.keys(store.liveCaptureQueue).length,25,'the 25 durable messages are identical');
  const forgery = await send({type:'hstryLiveCaptureBatch',captures:[valid(200)]},
    {...sender,id:'not-the-extension'});
  assert.equal(forgery.ok,false,'untrusted extension sender cannot add captures');
  assert.equal(writes,1);
  assert.equal(remoteCalls,0);

  store.liveCaptureQueue = {};
  writes = 0;
  const [tabA,tabB] = await Promise.all([
    send({type:'hstryLiveCaptureBatch',captures:Array.from({length:5},(_,i)=>valid(i+201))}),
    send({type:'hstryLiveCaptureBatch',captures:Array.from({length:5},(_,i)=>valid(i+206))}),
  ]);
  assert.equal(tabA.ok,true);
  assert.equal(tabB.ok,true);
  assert.equal(writes,2,'concurrent tab batches have exactly one queue write each');
  assert.equal(Object.keys(store.liveCaptureQueue).length,10,
    'concurrent batches cannot overwrite each other');
  assert.equal(remoteCalls,0);
  console.log('PASS capture batching: 25 -> 1 queue writes (-96%), 25 messages retained, legacy support, atomic validation, ACK-after-write, failed-write retry, concurrent tabs, revision order');
} finally {
  globalThis.chrome=originalChrome;
  globalThis.fetch=originalFetch;
}
