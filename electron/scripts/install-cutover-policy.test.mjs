import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { assertNoAutomaticWork, assertReviewedFutureCron, assertReviewedRetainedAutomation, assertStoppedEntries } from './install-cutover-policy.mjs';

const stopped = { queuedJobs: 0, possiblyDispatchedJobs: 0, enabledSchedules: 0, dueSchedules: 0,
  proactiveEnabled: false, proactiveDue: false, enabledTextSchedules: 0, dueTextSchedules: 0, eventProactiveEnabled: false,
  enabledChatCronSchedules: 0, pendingChatCronRuns: 0, pendingAutomaticTriggers: 0, pendingProactiveEvents: 0, pendingTimers: 0, dueTimers: 0, loginItemRequestedInSettings: false };

const chatRoundTwoRuntime = { sourceSHA256: '1dda591d1a34af91ec94bd48079f1af24a54d23ad4ee79305688a29ae4c8e350', mainSHA256: 'c7795778747c24501a9765d05a518ded8b5cd44e8b3e32149f88c17f81017aea' };
test('round-two cutover preserves inert preferences only with no actual automatic work', () => {
  const preferences = { ...stopped, proactiveEnabled: true, proactiveDue: true, loginItemRequestedInSettings: true };
  const before = { ...preferences };
  assert.equal(assertNoAutomaticWork(preferences, chatRoundTwoRuntime).exactReviewedRuntime, true);
  assert.deepEqual(preferences, before);
});
test('round-two cutover requires every typed zero including both cron counters', () => {
  const preferences = { ...stopped, proactiveEnabled: true, proactiveDue: true, loginItemRequestedInSettings: true };
  for (const [key, value] of Object.entries(stopped)) {
    const missing = { ...preferences }; delete missing[key];
    assert.throws(() => assertNoAutomaticWork(missing, chatRoundTwoRuntime), /Automatic work/u);
    if (!['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(key)) {
      for (const changed of [typeof value === 'boolean' ? true : 1, typeof value === 'boolean' ? 'false' : '0']) {
        assert.throws(() => assertNoAutomaticWork({ ...preferences, [key]: changed }, chatRoundTwoRuntime), /Automatic work/u);
      }
    }
  }
});
test('round-two cutover rejects source-only or main-only identity matches', () => {
  const preferences = { ...stopped, proactiveEnabled: true, proactiveDue: true, loginItemRequestedInSettings: true };
  for (const key of ['sourceSHA256', 'mainSHA256']) {
    assert.throws(() => assertNoAutomaticWork(preferences, { ...chatRoundTwoRuntime, [key]: '0'.repeat(64) }), /Automatic work/u);
  }
});

const chatRoundOneRuntime = { sourceSHA256: '315aa2c13418c8f8955070032a3934c8f3ce9f8517c7b10f7a1a300305cc4308', mainSHA256: '7fc418591634d19ffada3e70054e6400fecd78c8086329bfa3f4f6b329a0c80b' };
test('chat usability cutover preserves inert stored preferences without mutating them', () => {
  const preferences = { ...stopped, proactiveEnabled: true, proactiveDue: true, loginItemRequestedInSettings: true };
  const before = { ...preferences };
  assert.deepEqual(assertNoAutomaticWork(preferences, chatRoundOneRuntime), {
    exactReviewedRuntime: true, activeAutomaticWork: false, storedLegacyProactivePreserved: true,
    storedLoginIntentPreserved: true, startupRegistersLoginItem: false, newEventProactiveEnabled: false,
  });
  assert.deepEqual(preferences, before);
});
test('chat usability cutover rejects a changed source or binary identity', () => {
  const preferences = { ...stopped, proactiveEnabled: true, proactiveDue: true, loginItemRequestedInSettings: true };
  for (const key of ['sourceSHA256', 'mainSHA256']) {
    assert.throws(() => assertNoAutomaticWork(preferences, { ...chatRoundOneRuntime, [key]: '0'.repeat(64) }), /Automatic work/u);
  }
});
test('chat usability cutover still rejects active work and incomplete inspection metadata', () => {
  const preferences = { ...stopped, proactiveEnabled: true, proactiveDue: true, loginItemRequestedInSettings: true };
  for (const [key, value] of Object.entries(stopped)) {
    const missing = { ...preferences }; delete missing[key];
    assert.throws(() => assertNoAutomaticWork(missing, chatRoundOneRuntime), /Automatic work/u);
    if (!['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(key)) {
      assert.throws(() => assertNoAutomaticWork({ ...preferences, [key]: typeof value === 'boolean' ? true : 1 }, chatRoundOneRuntime), /Automatic work/u);
    }
  }
});

test('accepts the explicit all-stopped production inspection contract', () => assert.doesNotThrow(() => assertNoAutomaticWork(stopped)));

const pluginsResponsesRuntime = { sourceSHA256: '0e47495f185982141ecb2dd7f5f243b9d0e79cba654da111644cb6f8001808f7', mainSHA256: '223b39d510dc515b272cd7d6db4715e22d040063c380264c6b70617346bf0fff' };
test('plugin/Responses cutover preserves inert legacy preferences only for the audited artifact', () => {
  const legacy = { ...stopped, proactiveEnabled: true, proactiveDue: true, loginItemRequestedInSettings: true };
  assert.equal(assertNoAutomaticWork(legacy, pluginsResponsesRuntime).exactReviewedRuntime, true);
  assert.throws(() => assertNoAutomaticWork(legacy, { ...pluginsResponsesRuntime, mainSHA256: '0'.repeat(64) }));
  for (const [name, value] of Object.entries(stopped).filter(([key]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(key))) {
    assert.throws(() => assertNoAutomaticWork({ ...legacy, [name]: typeof value === 'boolean' ? true : 1 }, pluginsResponsesRuntime));
  }
});
for (const [name, value] of Object.entries(stopped)) {
  test(`rejects active ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...stopped, [name]: typeof value === 'boolean' ? true : 1 }), /Automatic work/u));
  test(`rejects absent ${name} instead of treating old reports as zero`, () => {
    const missing = { ...stopped }; delete missing[name]; assert.throws(() => assertNoAutomaticWork(missing), /Automatic work/u);
  });
}
test('does not coerce text counters or booleans', () => {
  assert.throws(() => assertNoAutomaticWork({ ...stopped, queuedJobs: '0' }));
  assert.throws(() => assertNoAutomaticWork({ ...stopped, eventProactiveEnabled: 0 }));
});
for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'restore-pending.json', 'recovery', '.staging', 'profile.enc.json.corrupt-123']) {
  test(`rejects stopped-copy blocker ${name} without deleting it`, () => assert.throws(() => assertStoppedEntries(['profile.enc.json', name]), /requires review/u));
}
test('accepts ordinary saved roots without reading their contents', () => assert.doesNotThrow(() => assertStoppedEntries(['profile.enc.json', 'vault', 'managed', 'settings.json'])));

const reviewedRuntime = { sourceSHA256: '196cefbe0c446d994a9e4d471f6e527bf668b71ea1f407943c651be49ae0d741', mainSHA256: 'a194da25c9b38f81a2d9e8259822307265775f837892a5aeac74781b993a9d8a' };
const legacyPreferences = { ...stopped, proactiveEnabled: true, proactiveDue: true, loginItemRequestedInSettings: true };
test('preserves inert legacy preferences only for the exact audited runtime', () => {
  assert.deepEqual(assertNoAutomaticWork(legacyPreferences, reviewedRuntime), { exactReviewedRuntime: true, activeAutomaticWork: false,
    storedLegacyProactivePreserved: true, storedLoginIntentPreserved: true, startupRegistersLoginItem: false, newEventProactiveEnabled: false });
  assert.equal(legacyPreferences.proactiveEnabled, true);
});
for (const runtime of [{}, { ...reviewedRuntime, mainSHA256: '0'.repeat(64) }, { ...reviewedRuntime, sourceSHA256: '0'.repeat(64) }]) {
  test(`rejects a legacy exception without exact source and binary identity ${JSON.stringify(runtime)}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`reviewed runtime still rejects real automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, reviewedRuntime)));
}
test('reviewed runtime still requires typed legacy metadata', () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, proactiveEnabled: undefined }, reviewedRuntime)));

const providerFixRuntime = { sourceSHA256: '118e9d7815506edb2728f1c56cab3a36a8170a82423aca1bf12c7581b5a82925', mainSHA256: '33bfcee8201b70274120718ca8fb16e07572c88b39a3df470b79c780125bb6e1' };
test('accepts the exact provider-diagnostics build without granting any automatic path', () => {
  assert.equal(assertNoAutomaticWork(legacyPreferences, providerFixRuntime).exactReviewedRuntime, true);
  assert.equal(legacyPreferences.proactiveEnabled, true);
});
for (const runtime of [{ ...providerFixRuntime, mainSHA256: reviewedRuntime.mainSHA256 }, { ...reviewedRuntime, mainSHA256: providerFixRuntime.mainSHA256 }]) {
  test(`rejects mismatched reviewed source/binary pairs ${runtime.sourceSHA256}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`provider-diagnostics build still rejects actual automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, providerFixRuntime)));
}

const proxyRuntime = { sourceSHA256: '71e953a8e84ab7c7315c6302754821b3b2db5447652014e6fb87b9f8bfaf8aef', mainSHA256: '113027f6cb0577394e3b1e96925266961d99bc2e2b3960d538d096a09aa6000d' };
test('accepts only the exact reviewed proxy-transport build', () => assert.equal(assertNoAutomaticWork(legacyPreferences, proxyRuntime).exactReviewedRuntime, true));
for (const runtime of [{ ...proxyRuntime, mainSHA256: providerFixRuntime.mainSHA256 }, { ...providerFixRuntime, mainSHA256: proxyRuntime.mainSHA256 }]) {
  test(`rejects mixed proxy/diagnostic binary identity ${runtime.sourceSHA256}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`proxy build still rejects actual automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, proxyRuntime)));
}

const chatP0Runtime = { sourceSHA256: '92f43355181b125a42cb8525d223ce6d5014e9288c31f6dcda82c2cf84845bcd', mainSHA256: 'b93cfceb2b1db6e97e71a88cbff942779ad197732bddfd49e39d78ec45a9da82' };
test('accepts only the exact reviewed chat-P0 build', () => assert.equal(assertNoAutomaticWork(legacyPreferences, chatP0Runtime).exactReviewedRuntime, true));
for (const runtime of [{ ...chatP0Runtime, mainSHA256: providerFixRuntime.mainSHA256 }, { ...providerFixRuntime, mainSHA256: chatP0Runtime.mainSHA256 }]) {
  test(`rejects mixed chat-P0/diagnostic binary identity ${runtime.sourceSHA256}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`chat-P0 build still rejects actual automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, chatP0Runtime)));
}

const contextFixRuntime = { sourceSHA256: '3f946e33aac9b47a273a1f150c99b1ac5f2a4bc1d3e619fdfe18d9610816fae4', mainSHA256: 'b6dd4defb87d1934007031b3ae4f5986bf6bcb9f9613de26eda40acda9170f55' };
test('accepts only the exact context-capacity and pagination repair build', () => assert.equal(assertNoAutomaticWork(legacyPreferences, contextFixRuntime).exactReviewedRuntime, true));
for (const runtime of [{ ...contextFixRuntime, mainSHA256: chatP0Runtime.mainSHA256 }, { ...chatP0Runtime, mainSHA256: contextFixRuntime.mainSHA256 }]) {
  test(`rejects mixed context-fix/chat-P0 identities ${runtime.sourceSHA256}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`context-fix build still rejects actual automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, contextFixRuntime)));
}

const trayRuntime = { sourceSHA256: '5bad0f46de8db2221740ba12616006a53129524b99dbb8aa1831d9f273dd4c5a', mainSHA256: '7d4079681ac6e636920ca8b99610f2e9e632980772b3c50f121ad21def29ca5d' };
test('accepts only the exact tray PNG repair build', () => assert.equal(assertNoAutomaticWork(legacyPreferences, trayRuntime).exactReviewedRuntime, true));
for (const runtime of [{ ...trayRuntime, mainSHA256: contextFixRuntime.mainSHA256 }, { ...contextFixRuntime, mainSHA256: trayRuntime.mainSHA256 }]) {
  test(`rejects mixed tray/context binary identity ${runtime.sourceSHA256}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`tray repair still rejects actual automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, trayRuntime)));
}

const tokenRecordingRuntime = { sourceSHA256: '638871fe7655d25d014a6382bd9f8d4946e9c942981453faa8c365e741b6b6d4', mainSHA256: 'ba20678ac59070f62a45581b6b5b5dcb14cb04a98bd9362fdbed798a724aeb6d' };
test('accepts only the reviewed token-recording build', () => assert.equal(assertNoAutomaticWork(legacyPreferences, tokenRecordingRuntime).exactReviewedRuntime, true));
for (const runtime of [{ ...tokenRecordingRuntime, mainSHA256: trayRuntime.mainSHA256 }, { ...trayRuntime, mainSHA256: tokenRecordingRuntime.mainSHA256 }]) {
  test(`rejects mixed token-recording/tray identity ${runtime.sourceSHA256}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`token-recording build still rejects actual automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, tokenRecordingRuntime)));
}

const attentionObserveRuntime = { sourceSHA256: '60c5e05a72b8978cb0c40accda6f00568fc0333efd2923fed0bd89b8df101d35', mainSHA256: '2725114074a4faf096b63844dbff95e112e2ec087b1c4c787fa58796ffc8d780' };
test('accepts the exact attention/observe build while preserving inert legacy settings', () => assert.equal(assertNoAutomaticWork(legacyPreferences, attentionObserveRuntime).exactReviewedRuntime, true));
for (const runtime of [{ ...attentionObserveRuntime, mainSHA256: tokenRecordingRuntime.mainSHA256 }, { ...tokenRecordingRuntime, mainSHA256: attentionObserveRuntime.mainSHA256 }]) {
  test(`rejects mixed attention/recording identity ${runtime.sourceSHA256}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`attention/observe build rejects active automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, attentionObserveRuntime)));
}

const live2dDragRuntime = { sourceSHA256: '4582fce7066dded07f21c82643146f157643414b9f25fa387c77b5ca76011443', mainSHA256: '271fddf5af7591f4e8dce66b513f11667cb65aef90db928fc9e32e8e7fc4dda8' };
test('accepts the exact reviewed Live2D drag build without changing stored legacy preferences', () => {
  const before = { ...legacyPreferences };
  assert.equal(assertNoAutomaticWork(legacyPreferences, live2dDragRuntime).exactReviewedRuntime, true);
  assert.deepEqual(legacyPreferences, before);
});
for (const runtime of [{ ...live2dDragRuntime, mainSHA256: attentionObserveRuntime.mainSHA256 }, { ...attentionObserveRuntime, mainSHA256: live2dDragRuntime.mainSHA256 }]) {
  test(`rejects mixed drag/attention source and binary identity ${runtime.sourceSHA256}`, () => assert.throws(() => assertNoAutomaticWork(legacyPreferences, runtime)));
}
for (const [name, value] of Object.entries(stopped).filter(([name]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(name))) {
  test(`Live2D drag build still rejects active automatic path ${name}`, () => assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [name]: typeof value === 'boolean' ? true : 1 }, live2dDragRuntime)));
}

const costRuntime = {
  sourceSHA256: 'f4ab2c51ea557e15c74ce35185d549e8f4d613e23447b47167457f0e32760100',
  mainSHA256: '5ac49ac408280fbd2fb24e0f4951eb12d72ffa52ba35bcb0460d5b8aa4a743e7',
  asarSHA256: 'e6afbe97337067e13788ca017df05bdd11b0812499525ba2483b8af2a4823df6',
};
const reviewNow = Date.parse('2026-11-02T12:30:00.000Z');
const scheduledRunRuntime = {
  sourceSHA256: '9544d8f13ac84bcf5c6da80d92533f2cfc993821a8a790cc94652076bb4daebb',
  mainSHA256: 'e5c980a7443c61151e99b710e2315929f3e7006cd19a8966649a35f2d62e49b4',
  asarSHA256: '0beebd9eb405cfab513433b2ba8b2cfdb9851bd8f95dae75133704fefebf1fd7',
};
const chatBatchRuntime = {
  sourceSHA256: '7f9fbe19ec17fe24d2e652d7d90cb7e51b3534a6c696eb0022c367139fc736ec',
  mainSHA256: 'b8a6a90a5753207cc8f7ded6b189b6c6b5971c9cea6ca2a05b39ca8d15e1b0e1',
  asarSHA256: '6a0cd721ce40c02bfe1c420d50fb39e4163ba2147a766614f91440202f28fd05',
};
const reliabilityRuntime = {
  sourceSHA256: 'e79b0d0e5bbbe690912e546e755f6537f4e27633d16bde73d2f3b2efed3dcdab',
  mainSHA256: '609996d09144e20fd6a21cc051cf54dee2dc11380456928f1904398f46e78d64',
  asarSHA256: '581176f2dd7a6f47b877ec1de81e046f5c410f5b6bbf5cdace45fd9d03137620',
};
const characterRuntime = {
  sourceSHA256: '94a9b5980170af74b1fb4a7acc280f859516e7b09eea929fd55c2452fd65f3cd',
  mainSHA256: 'c6bb5621f34ae473e5743c0a95277faca29adb15e32d0fe8b94fc6407867ce6b',
  asarSHA256: '53a69ec443f270d2b31eacb81794aaa9016041bd5b35a736a9b411b0e2f5b7d5',
};
const interfaceRuntime = {
  sourceSHA256: 'cfd3e3ba68bfa85021a5119d2ea0d8b1e945709d6edad3a7f94f8af691d4d3f7',
  mainSHA256: 'dcb79068d51654beaf66d4f116e5f644dcf19f3bbaf352f59f6810d4a1b63e4c',
  asarSHA256: 'fa3921142d23223d953c100a319b9404aa532e29604a9efc40e4086b8d2aac5e',
};
const interfaceFixesRuntime = {
  sourceSHA256: 'cdf6b4f7e43dab18d2e596d41e13ef5743b6ae3b6ea4018aa9c2687aba08c19e',
  mainSHA256: '217f6d4002c1ddcbf55bc4a7da655aa4e0e3951f5a6fa56dbf3a15245d5f6cf4',
  asarSHA256: '245624034a1a3fe2905a9408a86341c268a45008f9fb982bfeabfef612f59641',
};
const qqGroupPairingRuntime = {
  sourceSHA256: '51c4c3b48cc4a4c9443d7ac046cb3fffd4f06a4abfecbd735349ff6ab83090d4',
  mainSHA256: '1ba033d4716dcc9df9f87fd013bf20cde9d9cbea7cde9e44c993f5245b60e516',
  asarSHA256: 'f26bdc24818085ee7d020dc1e77894b97dbe8aa9fa622c3fc1207d87766edc2a',
};
const qqDiagnosticsRuntime = {
  sourceSHA256: '3ae7a0fc099279e8a6ea55f258d34f0ed111f8e5c3f30b771fc568d4d91b4351',
  mainSHA256: '92027ac7db3612e5f165010d505432fa4023f4cda1cc507ece422810600d3d90',
  asarSHA256: '40e45929b944d1c1079156138d6d79319bc7dd9ab3a098832071a34cc5c88a42',
};
const qqSequenceRuntime = {
  sourceSHA256: '97b96f43df592d4f4710d576e0b574de2a74e0783a18c61ee235f2050a231162',
  mainSHA256: '1d59dd6d2b8f20a8921ee5183e689d2301938980a204ab7afc1d02600f180567',
  asarSHA256: '648ab70dd83fab38233ba23e094c8cbc78ef50f8cde5066ad16763c13fbe7eb4',
};
const qqMessageIdRuntime = {
  sourceSHA256: '7b8da464e14ba9ea603d44b85a241665c6ed2db8da7417bb98c65758ba8ba9f0',
  mainSHA256: '3588c65278d289456b335c2d5882bbe6f6c45219f6ab15b13ac1a6d5d0e358f8',
  asarSHA256: '4c4f4fbfbc0cde5a97ad74465b7d216258c5cb0c1dcd69e502f5153c99e05e79',
};
const qqPrivateDeliveryRuntime = {
  sourceSHA256: '4c3a3fbd8ebbe6740f9510219c489fe71af79da6628cc81e6b74a685d66b90a9',
  mainSHA256: '4d738abc9f1def1ea282b09fc63bfbc42a6ba401e678a911b2a99c9939903ead',
  asarSHA256: '3fae1abc1a2cc6d901c9e0b0099e1dcbd4b6846405f998b6754ca1311ceb239f',
};
const qqWebBudgetRuntime = {
  sourceSHA256: '3a76c7674ddbf2aee04ee86a2dcc1022327f77d0379d182763400f9c52ea5c18',
  mainSHA256: '87d12092061dd77c868147f3c139fcc90a5a14a94291d0c4e02dcc5e56a6c2a2',
  asarSHA256: 'e8be038e4bb35fd24c0bba1d23039c346ecc841ba13c4af03dc76c267167ddeb',
};
const extensionsRuntime = {
  "sourceSHA256": "6c53cd7873511086c6bdee758d29b54aa64a1295c55b243d9facb6c785cdf9c2",
  "mainSHA256": "6e7ac9bec882d23f01df8a76d9ea09dcfeab17a97a1789edbe7d9ac3dc89bf74",
  "asarSHA256": "abe25850d2e4d350b962d8bd151442446b93e815723a64b2246e1251cb0c03e2"
};
const minecraftCompanionRuntime = {
  sourceSHA256: 'f0fbfc619934378bf5152d05660a6b03f87f6bae809e354ce304073269235462',
  mainSHA256: '7d461f3edcb1eb6c11a8c9e6b6350d4a857f99fe4617fba852ccab49eed3968a',
  asarSHA256: '61005d3352490a5cf01e1c0425bc117a2392cb13b59c56c7f695a5e121a70b73',
};
// Owner-authorized optional check-in repair: request sampling compatibility,
// safe error categories and read-only grouped notices. Existing automatic policy,
// permissions and schedules remain subject to the exact stopped-copy reviews.
const attentionRuntime = {
  sourceSHA256: 'f30d7b9793ee4849a6108dda8e9345c2797c87f2c5ab1f9dc204c6c8064a376b',
  mainSHA256: '781707907f05800f64bceace83ecbe48ac555128f29d0b8188e5bf89c4368568',
  asarSHA256: 'bede15d962fcbde28adb4de3a6ab835271c5447d7c755a324cff1920d0c050a0',
};

// Owner-authorized default Chinese check-in wording only. Keep the existing
// event policy, provider binding, grants and schedules under exact copy review.
const chineseCheckInRuntime = {
  sourceSHA256: '48f603ccaebffb4be4a7e3903da2972b9782654c17cea42d8397e671c0f1187a',
  mainSHA256: 'a2bf3a5659981b7f2455869f911c3d1974f574176eaf4325e73e5170f30ac46f',
  asarSHA256: '9a9bc33bf1e9d05f1098e155fe5ad8da22a50b249785cebe58e62c84b4caa0c4',
};

// Owner-requested local image attachments, managed library and typed NapCat images.
// Image generation is explicit only; existing automatic authority still requires
// the same stopped-copy, credential and exact-artifact review.
const mediaLibraryRuntime = {
  sourceSHA256: '50908c12219b1dd7e41d930ed794b1ce9f6b1cb5db51adaa898fe7dd3699ca4e',
  mainSHA256: '40d03cd25376d790cbca67eea765a17d0a5d131654fec9455855918804dcc47b',
  asarSHA256: '2c842192447ed2fea967c06827f6ed7b0641780ffea0bdb0a81cc0a360504a94',
};

// Official QQ gallery uploads and replies preserve the existing channel grants.
const officialQqImageRuntime = {
  sourceSHA256: '40dd2122a56ea556fd645cdd4dee0d084bdaf0b3a56003aaaaf14985b0529aab',
  mainSHA256: '87cbe639a35e3222e23f6ff3db912085c2d36933c4670708a6f8b5a05af0db90',
  asarSHA256: '57ffd78735af3a58b32791a47d7d2384d1cfbdc8dcb3d6789f9f1a04c641b666',
};

// Official QQ private reply intent and standalone gallery stickers.
const qqPersonaStickerRuntime = {
  sourceSHA256: 'e995f22f4f19c99b6f3bf702e06ef2ecf866cbf6d316a4246a91af2382d9674d',
  mainSHA256: '75f80fc13e4e325a147d4f5caf2226afa7a49b74a9d27f074d714f7277856f70',
  asarSHA256: 'e04fcd0d3202b19e8fd64cb4e2108703583ce657c8c9bc889b1fbf7e7700eebe',
};

const privacyEfficiencyRuntime = {
  sourceSHA256: '078e7ae206081fe5157fce626effd01c48c19167c8636e012978102a4e423cfc',
  mainSHA256: '9d7b860dad7b8b5c73d08c3a7a8c52e8ec7ffc76f2536ea8aa15377def508977',
  asarSHA256: 'cc687921d76bb6b88eb27dd08f3f49747f4bdff105d64008a5ebabfd6fffc2ed',
};

const futureCronFixture = (expected = costRuntime) => {
  const identity = { isPackaged: true, mainBundleSHA256: expected.mainSHA256, build: { sourceSHA256: expected.sourceSHA256 } };
  const review = {
    operation: 'read-only-enabled-cron-review', readOnly: true, sourceUnchanged: true,
    appASARSHA256: expected.asarSHA256, runtimeIdentity: globalThis.structuredClone(identity),
    profilePath: '/tmp/reviewed-profile-copy', profileSHA256: '1'.repeat(64), checkedAt: '2026-11-02T12:29:00.000Z',
    providerSecretValuesRead: false, instructionTextExported: false, enabledCount: 1,
    schedules: [{ id: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
      providerId: '33333333-3333-4333-8333-333333333333', model: 'synthetic-model', enabled: true, revision: 1,
      expression: '0 7 * * *', timezone: 'Asia/Shanghai', missedPolicy: 'skip', allowedCapabilities: ['web.search', 'time.read'],
      nextRunAt: '2026-11-02T23:00:00.000Z', cancelledAt: null, scheduleSHA256: '2'.repeat(64), dueNow: false,
      sessionActive: true, providerEnabled: true, pendingRuns: 0 }],
    persistentGrants: [{ capabilityId: 'web.search', scope: 'always', expiresAt: null }, { capabilityId: 'time.read', scope: 'always', expiresAt: null }],
  };
  const compatibility = {
    verdict: 'PASS', operation: 'read-only-profile-inspection', readOnly: true, sourceUnchangedDuringRead: true,
    compatibleWithCurrentSchema: true, artifactMode: 'daily', runtimeName: 'DeskPet Electron', providerSecretValuesRead: false,
    projectionOnly: { pendingRestorePresent: false, noProjectionCommitted: true }, appASARSHA256: expected.asarSHA256,
    runtimeIdentity: identity, profilePath: review.profilePath, files: { profile: { sha256: review.profileSHA256 } },
    automaticPaths: { ...legacyPreferences, enabledChatCronSchedules: 1 },
  };
  return { compatibility, runtime: { ...expected }, review, now: reviewNow };
};
const futureDecision = ({ compatibility, runtime, review, now }) => assertReviewedFutureCron(compatibility, runtime, review, now);
const minecraftFutureFixture = () => {
  const fixture = futureCronFixture(minecraftCompanionRuntime);
  fixture.compatibility.automaticPaths.nightlyMemoryEnabled = false;
  return fixture;
};
const privacyEfficiencyFixture = () => {
  const fixture = futureCronFixture(privacyEfficiencyRuntime);
  const workCounts = { researchQueued: 0, researchRunning: 0, researchResumable: 0, streamingMessages: 0,
    runningChatTasks: 0, unconfirmedProactivePublications: 0, activeFocus: 0 };
  const channelChecks = { qqQueue: 0, qqReminders: 0, qqInboundQueued: 0, qqInboundRunning: 0,
    qqInboundPaused: 0, qqCronCount: 0, telegramCronDeliveries: 0, telegramStatePresent: false };
  Object.assign(fixture.compatibility.automaticPaths, { nightlyMemoryEnabled: false, researchQueued: 0, researchRunning: 0,
    qqInboundQueued: 0, qqInboundRunning: 0, qqInboundPaused: 0 });
  Object.assign(fixture.review, { privateTextExported: false, workCounts, channelChecks });
  fixture.compatibility.supplementalInspection = { operation: fixture.review.operation,
    profileSHA256: fixture.review.profileSHA256, checkedAt: fixture.review.checkedAt, privateTextExported: false,
    nightlyFieldPresent: true, nightlyDefaultFromExactArtifact: false, workCounts, channelChecks };
  return fixture;
};
test('the privacy/efficiency package preserves only freshly reviewed future work under the existing supplemental gates', () => {
  const fixture = privacyEfficiencyFixture(), before = globalThis.structuredClone(fixture);
  assert.equal(futureDecision(fixture).reviewedFutureCron.noNewPermissionsGranted, true);
  assert.equal(futureDecision(fixture).reviewedFutureCron.noCatchUpAuthorized, true);
  for (const key of Object.keys(privacyEfficiencyRuntime)) {
    assert.throws(() => futureDecision({ ...fixture, runtime: { ...fixture.runtime, [key]: '0'.repeat(64) } }));
  }
  for (const key of ['nightlyMemoryEnabled', 'researchQueued', 'researchRunning', 'qqInboundQueued', 'qqInboundRunning', 'qqInboundPaused', 'pendingChatCronRuns']) {
    const changed = globalThis.structuredClone(fixture);
    changed.compatibility.automaticPaths[key] = key === 'nightlyMemoryEnabled' ? true : 1;
    assert.throws(() => futureDecision(changed));
  }
  const missing = globalThis.structuredClone(fixture); delete missing.compatibility.supplementalInspection;
  assert.throws(() => futureDecision(missing));
  assert.deepEqual(fixture, before);
});
test('the privacy/efficiency upgrade requires the exact memory predecessor and unchanged dormant channel and policy evidence', () => {
  const fixture = privacyEfficiencyFixture(), c = fixture.compatibility;
  c.automaticPaths.eventProactiveEnabled = true;
  c.files.wrappedKey = { sha256: '3'.repeat(64) }; c.files.settings = { sha256: '4'.repeat(64) };
  const review = { operation: 'read-only-retained-automation-review', readOnly: true, preserveExistingOnly: true,
    sourceUnchanged: true, providerSecretValuesRead: false, instructionTextExported: false, privateTextExported: false,
    previousAppASARSHA256: '493b6f6a5305a67140a387bac471dcbc3697dbdcc289607b67ab158a339c0ea4',
    appASARSHA256: fixture.runtime.asarSHA256, runtimeIdentity: c.runtimeIdentity, profilePath: c.profilePath,
    profileSHA256: c.files.profile.sha256, wrappedKeySHA256: c.files.wrappedKey.sha256, settingsSHA256: c.files.settings.sha256,
    checkedAt: fixture.review.checkedAt, nightlyMemoryEnabled: false, eventProactiveEnabled: true, mode: 'auto',
    hasPersistentAutomationGrant: true, policyRevision: 2, timezone: 'UTC', policySHA256: '5'.repeat(64), grantsSHA256: '6'.repeat(64),
    workCounts: fixture.review.workCounts, channelChecks: { ...fixture.review.channelChecks, qqCare: true },
    qq: { stateSHA256: '7'.repeat(64), wrappedKeySHA256: '8'.repeat(64), bindingSHA256: '9'.repeat(64), configSHA256: 'a'.repeat(64),
      profileMatches: true, bindingSessionMatches: true, privateCareAuthorityMatches: true, remindersAuthorityMatches: true,
      privateCareEnabled: true, remindersEnabled: true, pendingOutbox: 0, pendingReminders: 0, pendingConfirmations: 0,
      pairingPending: false, inboundQueued: 0, inboundRunning: 0, inboundPaused: 0 } };
  const files = { previousAppASARSHA256: review.previousAppASARSHA256, profileSHA256: review.profileSHA256,
    wrappedKeySHA256: review.wrappedKeySHA256, settingsSHA256: review.settingsSHA256, qqStateSHA256: review.qq.stateSHA256,
    qqWrappedKeySHA256: review.qq.wrappedKeySHA256, telegramStatePresent: false };
  const decide = (r = review, f = files) => assertReviewedRetainedAutomation(c, fixture.runtime, r, f, fixture.now);
  const before = globalThis.structuredClone({ c, review, files });
  assert.equal(decide().noNewPermissionsGranted, true);
  assert.throws(() => futureDecision(fixture));
  for (const key of Object.keys(files)) assert.throws(() => decide(review, { ...files, [key]: '0'.repeat(64) }));
  for (const previous of ['f'.repeat(64), qqPersonaStickerRuntime.asarSHA256, fixture.runtime.asarSHA256]) {
    assert.throws(() => decide({ ...review, previousAppASARSHA256: previous }, { ...files, previousAppASARSHA256: previous }));
  }
  const telegram = { version: 1, schemaValidated: true, validationScope: 'dormant-state-shape', enabled: false,
    tokenConfigured: false, profileMatches: true, hasBinding: false, pairingPending: false, inbox: 0,
    outstandingOutbox: 0, approvals: 0, stateSHA256: 'b'.repeat(64), wrappedKeySHA256: 'c'.repeat(64) };
  const withTelegram = { ...review, telegram, channelChecks: { ...review.channelChecks, telegramStatePresent: true } };
  const telegramFiles = { ...files, telegramStatePresent: true, telegramStateSHA256: telegram.stateSHA256, telegramWrappedKeySHA256: telegram.wrappedKeySHA256 };
  c.supplementalInspection.channelChecks = { ...c.supplementalInspection.channelChecks, telegramStatePresent: true };
  assert.equal(decide(withTelegram, telegramFiles).noQueuedDeliveryAuthorized, true);
  for (const [key, value] of [['validationScope', 'other'], ['enabled', true], ['tokenConfigured', true], ['inbox', 1], ['approvals', 1]]) {
    assert.throws(() => decide({ ...withTelegram, telegram: { ...telegram, [key]: value } }, telegramFiles));
  }
  c.supplementalInspection.channelChecks = before.c.supplementalInspection.channelChecks;
  assert.deepEqual({ c, review, files }, before);
});
test('the reviewed Minecraft package preserves inert preferences only with its exact three-part identity', () => {
  const paths = { ...legacyPreferences, nightlyMemoryEnabled: false };
  const before = globalThis.structuredClone(paths);
  assert.equal(assertNoAutomaticWork(paths, minecraftCompanionRuntime).exactReviewedRuntime, true);
  for (const key of Object.keys(minecraftCompanionRuntime)) {
    assert.throws(() => assertNoAutomaticWork(paths, { ...minecraftCompanionRuntime, [key]: '0'.repeat(64) }), /Automatic work/u);
  }
  assert.throws(() => assertNoAutomaticWork({ ...paths, nightlyMemoryEnabled: true }, minecraftCompanionRuntime), /Automatic work/u);
  assert.throws(() => assertNoAutomaticWork({ ...paths, pendingChatCronRuns: 1 }, minecraftCompanionRuntime), /Automatic work/u);
  assert.deepEqual(paths, before);
});
test('the reviewed Minecraft package accepts only freshly reviewed existing future cron without granting Minecraft cron scope', () => {
  const fixture = minecraftFutureFixture(), before = globalThis.structuredClone(fixture);
  const decision = futureDecision(fixture);
  assert.equal(decision.futureCronPreserved, true);
  assert.equal(decision.reviewedFutureCron.noNewPermissionsGranted, true);
  assert.equal(decision.reviewedFutureCron.noImmediateRunAuthorized, true);
  assert.equal(decision.reviewedFutureCron.noCatchUpAuthorized, true);
  assert.deepEqual(fixture, before);
  fixture.review.schedules[0].allowedCapabilities.push('minecraft.control');
  fixture.review.persistentGrants.push({ capabilityId: 'minecraft.control', scope: 'always', expiresAt: null });
  assert.throws(() => futureDecision(fixture), /Future cron review/u);
});
test('the redesign package needs its exact identity, a disabled nightly path and empty task and QQ queues', () => {
  const redesignRuntime = { sourceSHA256: '9169e8fcdb086430bd6acded9c99dee918bf0192a488102e5d59da6e38e9cdc8',
    mainSHA256: '6f71580e56302719ad407ee26b0a2d9ded04b3292e6db62aa889771ed2966f83', asarSHA256: '6994d4fe8d4e6a3b7ceca7fa5671dfb7153744c87387530ffcccbf45778ff090' };
  const paths = { ...legacyPreferences, nightlyMemoryEnabled: false, researchQueued: 0, researchRunning: 0, qqInboundQueued: 0, qqInboundRunning: 0, qqInboundPaused: 0 };
  assert.equal(assertNoAutomaticWork(paths, redesignRuntime).exactReviewedRuntime, true);
  for (const key of Object.keys(redesignRuntime)) {
    assert.throws(() => assertNoAutomaticWork(paths, { ...redesignRuntime, [key]: '0'.repeat(64) }), /Automatic work/u);
  }
  for (const key of ['researchQueued', 'researchRunning', 'qqInboundQueued', 'qqInboundRunning', 'qqInboundPaused', 'pendingChatCronRuns']) {
    assert.throws(() => assertNoAutomaticWork({ ...paths, [key]: 1 }, redesignRuntime), /Automatic work/u);
  }
  assert.throws(() => assertNoAutomaticWork({ ...paths, nightlyMemoryEnabled: true }, redesignRuntime), /Automatic work/u);
  assert.throws(() => assertNoAutomaticWork({ ...paths, researchQueued: undefined }, redesignRuntime), /Automatic work/u);
});
test('the memory package needs its exact identity and empty task and QQ queues', () => {
  const memoryRuntime = { sourceSHA256: 'e78892af3f50bc2489ad1ee77fafc76c2a15a8cd9abc15380686b7749725954e',
    mainSHA256: '8de4d249823a9c802aed7a2cc5770fdfb8f2cdd7ceb5caae9e35a7d8b22f0136', asarSHA256: '493b6f6a5305a67140a387bac471dcbc3697dbdcc289607b67ab158a339c0ea4' };
  const paths = { ...legacyPreferences, nightlyMemoryEnabled: false, researchQueued: 0, researchRunning: 0, qqInboundQueued: 0, qqInboundRunning: 0, qqInboundPaused: 0 };
  assert.equal(assertNoAutomaticWork(paths, memoryRuntime).exactReviewedRuntime, true);
  for (const key of Object.keys(memoryRuntime)) {
    assert.throws(() => assertNoAutomaticWork(paths, { ...memoryRuntime, [key]: '0'.repeat(64) }), /Automatic work/u);
  }
  for (const key of ['researchQueued', 'qqInboundQueued', 'pendingChatCronRuns']) {
    assert.throws(() => assertNoAutomaticWork({ ...paths, [key]: 1 }, memoryRuntime), /Automatic work/u);
  }
});
test('cost pair preserves only inert preferences by default and still rejects every automatic path', () => {
  assert.equal(assertNoAutomaticWork(legacyPreferences, costRuntime).exactReviewedRuntime, true);
  for (const [key, value] of Object.entries(stopped).filter(([key]) => !['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(key))) {
    assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, [key]: typeof value === 'boolean' ? true : 1 }, costRuntime));
  }
  for (const key of ['sourceSHA256', 'mainSHA256']) assert.throws(() => assertNoAutomaticWork(legacyPreferences, { ...costRuntime, [key]: '0'.repeat(64) }));
});
test('scheduled-run build preserves its reviewed future cron and rejects any mixed identity', () => {
  assert.equal(assertNoAutomaticWork(legacyPreferences, scheduledRunRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(scheduledRunRuntime)).futureCronPreserved, true);
  for (const key of ['sourceSHA256', 'mainSHA256', 'asarSHA256']) {
    assert.throws(() => futureDecision({ ...futureCronFixture(scheduledRunRuntime), runtime: { ...scheduledRunRuntime, [key]: costRuntime[key] } }), /Future cron review/u);
  }
  const crossed = futureCronFixture(scheduledRunRuntime);
  crossed.review.appASARSHA256 = costRuntime.asarSHA256;
  assert.throws(() => futureDecision(crossed), /Future cron review/u);
  const pending = futureCronFixture(scheduledRunRuntime);
  pending.compatibility.automaticPaths.pendingChatCronRuns = 1;
  assert.throws(() => futureDecision(pending), /Automatic work/u);
});
test('chat batch build preserves its reviewed future cron and rejects any mixed identity', () => {
  assert.equal(assertNoAutomaticWork(legacyPreferences, chatBatchRuntime).exactReviewedRuntime, true);
  assert.equal(assertNoAutomaticWork(legacyPreferences, reliabilityRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(reliabilityRuntime)).futureCronPreserved, true);
  assert.equal(assertNoAutomaticWork(legacyPreferences, characterRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(characterRuntime)).futureCronPreserved, true);
  assert.equal(assertNoAutomaticWork(legacyPreferences, interfaceRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(interfaceRuntime)).futureCronPreserved, true);
  assert.equal(assertNoAutomaticWork(legacyPreferences, interfaceFixesRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(interfaceFixesRuntime)).futureCronPreserved, true);
  assert.equal(assertNoAutomaticWork(legacyPreferences, qqGroupPairingRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(qqGroupPairingRuntime)).futureCronPreserved, true);
  assert.equal(assertNoAutomaticWork(legacyPreferences, qqDiagnosticsRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(qqDiagnosticsRuntime)).futureCronPreserved, true);
  assert.equal(assertNoAutomaticWork(legacyPreferences, qqSequenceRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(qqSequenceRuntime)).futureCronPreserved, true);
  assert.equal(assertNoAutomaticWork(legacyPreferences, qqMessageIdRuntime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(qqMessageIdRuntime)).futureCronPreserved, true);
  assert.equal(futureDecision(futureCronFixture(chatBatchRuntime)).futureCronPreserved, true);
  for (const key of ['sourceSHA256', 'mainSHA256', 'asarSHA256']) {
    assert.throws(() => futureDecision({ ...futureCronFixture(chatBatchRuntime), runtime: { ...chatBatchRuntime, [key]: scheduledRunRuntime[key] } }), /Future cron review/u);
  }
  const crossed = futureCronFixture(chatBatchRuntime);
  crossed.review.appASARSHA256 = scheduledRunRuntime.asarSHA256;
  assert.throws(() => futureDecision(crossed), /Future cron review/u);
});
test('explicit future review preserves exact schedule identity without mutating reports or permissions', () => {
  const fixture = futureCronFixture(), before = globalThis.structuredClone(fixture), decision = futureDecision(fixture);
  assert.equal(decision.futureCronPreserved, true);
  assert.equal(decision.reviewedFutureCron.enabledCount, 1);
  assert.equal(decision.reviewedFutureCron.noImmediateRunAuthorized, true);
  assert.equal(decision.reviewedFutureCron.noCatchUpAuthorized, true);
  assert.equal(decision.reviewedFutureCron.noNewPermissionsGranted, true);
  assert.deepEqual(decision.reviewedFutureCron.schedules, [{ id: fixture.review.schedules[0].id, revision: 1,
    scheduleSHA256: '2'.repeat(64), nextRunAt: '2026-11-02T23:00:00.000Z', missedPolicy: 'skip' }]);
  assert.deepEqual(fixture, before);
  assert.throws(() => assertNoAutomaticWork(fixture.compatibility.automaticPaths, fixture.runtime));
});
test('private QQ delivery build requires its exact daily artifact even for inert legacy preferences', () => {
  const runtime = qqPrivateDeliveryRuntime;
  assert.equal(assertNoAutomaticWork(legacyPreferences, runtime).exactReviewedRuntime, true);
  assert.equal(futureDecision(futureCronFixture(runtime)).futureCronPreserved, true);
  for (const key of Object.keys(runtime)) {
    const mixed = { ...runtime, [key]: qqMessageIdRuntime[key] };
    assert.throws(() => assertNoAutomaticWork(legacyPreferences, mixed), /Automatic work/u);
    assert.throws(() => futureDecision(futureCronFixture(mixed)), /Future cron review/u);
  }
  assert.throws(() => assertNoAutomaticWork({ ...legacyPreferences, pendingTimers: 1 }, runtime), /Automatic work/u);
  const active = futureCronFixture(runtime);
  active.compatibility.automaticPaths.eventProactiveEnabled = true;
  assert.throws(() => futureDecision(active), /Automatic work/u);
});
test('QQ continuation daily build also requires a disabled nightly path in the reviewed copy', () => {
  const paths = { ...legacyPreferences, nightlyMemoryEnabled: false };
  assert.equal(assertNoAutomaticWork(paths, qqWebBudgetRuntime).exactReviewedRuntime, true);
  assert.throws(() => assertNoAutomaticWork(legacyPreferences, qqWebBudgetRuntime), /Automatic work/u);
  for (const value of [true, null, 'false', 0]) {
    assert.throws(() => assertNoAutomaticWork({ ...paths, nightlyMemoryEnabled: value }, qqWebBudgetRuntime), /Automatic work/u);
  }
  const fixture = futureCronFixture(qqWebBudgetRuntime);
  assert.throws(() => futureDecision(fixture), /Automatic work/u);
  fixture.compatibility.automaticPaths.nightlyMemoryEnabled = false;
  assert.equal(futureDecision(fixture).futureCronPreserved, true);
  fixture.compatibility.automaticPaths.nightlyMemoryEnabled = true;
  assert.throws(() => futureDecision(fixture), /Automatic work/u);
  for (const key of Object.keys(qqWebBudgetRuntime)) {
    assert.throws(() => assertNoAutomaticWork(paths, { ...qqWebBudgetRuntime, [key]: qqPrivateDeliveryRuntime[key] }), /Automatic work/u);
  }
  assert.throws(() => assertNoAutomaticWork({ ...paths, pendingChatCronRuns: 1 }, qqWebBudgetRuntime), /Automatic work/u);
});
for (const target of [qqWebBudgetRuntime, extensionsRuntime, minecraftCompanionRuntime, attentionRuntime, chineseCheckInRuntime,mediaLibraryRuntime,officialQqImageRuntime,qqPersonaStickerRuntime]) test('retaining existing care requires exact profile, key, channel, permission and artifact evidence without changing reports for '+target.asarSHA256, () => {
  const previous=target===qqPersonaStickerRuntime?officialQqImageRuntime:target===officialQqImageRuntime?mediaLibraryRuntime:target===mediaLibraryRuntime?chineseCheckInRuntime:target===chineseCheckInRuntime?attentionRuntime:target===attentionRuntime?minecraftCompanionRuntime:target===minecraftCompanionRuntime?extensionsRuntime:target===extensionsRuntime?qqWebBudgetRuntime:qqPrivateDeliveryRuntime;
  const fixture = futureCronFixture(target), c = fixture.compatibility;
  c.automaticPaths.nightlyMemoryEnabled = false; c.automaticPaths.eventProactiveEnabled = true;
  c.files.wrappedKey = { sha256: '3'.repeat(64) }; c.files.settings = { sha256: '4'.repeat(64) };
  const review = {
    operation: 'read-only-retained-automation-review', readOnly: true, preserveExistingOnly: true, sourceUnchanged: true,
    providerSecretValuesRead: false, instructionTextExported: false, previousAppASARSHA256: previous.asarSHA256,
    appASARSHA256: target.asarSHA256, runtimeIdentity: c.runtimeIdentity, profilePath: c.profilePath,
    profileSHA256: c.files.profile.sha256, wrappedKeySHA256: c.files.wrappedKey.sha256, settingsSHA256: c.files.settings.sha256,
    checkedAt: fixture.review.checkedAt, nightlyMemoryEnabled: false, eventProactiveEnabled: true,
    mode: 'auto', hasPersistentAutomationGrant: true, policyRevision: 2, timezone: 'UTC', policySHA256: '5'.repeat(64), grantsSHA256: '6'.repeat(64),
    qq: { stateSHA256: '7'.repeat(64), wrappedKeySHA256: '8'.repeat(64), bindingSHA256: '9'.repeat(64), configSHA256: 'a'.repeat(64),
      profileMatches: true, bindingSessionMatches: true, privateCareAuthorityMatches: true, remindersAuthorityMatches: true,
      privateCareEnabled: true, remindersEnabled: true, pendingOutbox: 0, pendingReminders: 0, pendingConfirmations: 0, pairingPending: false },
    channelChecks: { qqQueue: 0, qqReminders: 0, qqCare: true, telegramStatePresent: false, qqCronCount: 0, telegramCronDeliveries: 0 },
  };
  const files = { previousAppASARSHA256: review.previousAppASARSHA256, profileSHA256: review.profileSHA256,
    wrappedKeySHA256: review.wrappedKeySHA256, settingsSHA256: review.settingsSHA256,
    qqStateSHA256: review.qq.stateSHA256, qqWrappedKeySHA256: review.qq.wrappedKeySHA256, telegramStatePresent: false };
  const before = globalThis.structuredClone({ c, review, files });
  const decide = (r = review, current = files) => assertReviewedRetainedAutomation(c, fixture.runtime, r, current, fixture.now);
  assert.equal(decide().retainedAutomationPreserved, true); assert.equal(decide().noNewPermissionsGranted, true);
  assert.throws(() => futureDecision(fixture), /Automatic work/u);
  assert.equal(futureDecision({ ...fixture, compatibility: { ...c, automaticPaths: { ...c.automaticPaths, eventProactiveEnabled: false } } }).futureCronPreserved, true);
  for (const key of Object.keys(files)) assert.throws(() => decide(review, { ...files, [key]: '0'.repeat(64) }), /Existing automation review/u);
  for (const [key, value] of [['readOnly', false], ['preserveExistingOnly', false], ['hasPersistentAutomationGrant', false], ['mode', 'observe'], ['nightlyMemoryEnabled', true], ['profileSHA256', '0'.repeat(64)], ['checkedAt', '2026-11-01T00:00:00.000Z'], ['previousAppASARSHA256', target.asarSHA256]]) {
    assert.throws(() => decide({ ...review, [key]: value }), /Existing automation review/u);
  }
  for (const [key, value] of [['profileMatches', false], ['bindingSessionMatches', false], ['privateCareAuthorityMatches', false], ['remindersAuthorityMatches', false], ['pendingOutbox', 1], ['pendingConfirmations', 1], ['pairingPending', true]]) {
    assert.throws(() => decide({ ...review, qq: { ...review.qq, [key]: value } }), /Existing automation review/u);
  }
  const telegram = { version: 1, schemaValidated: true, enabled: false, tokenConfigured: false, profileMatches: true,
    hasBinding: false, pairingPending: false, inbox: 0, outstandingOutbox: 0, approvals: 0,
    stateSHA256: 'b'.repeat(64), wrappedKeySHA256: 'c'.repeat(64) };
  const withTelegram = { ...review, telegram, channelChecks: { ...review.channelChecks, telegramStatePresent: true } };
  const telegramFiles = { ...files, telegramStatePresent: true, telegramStateSHA256: telegram.stateSHA256, telegramWrappedKeySHA256: telegram.wrappedKeySHA256 };
  if (target === qqPersonaStickerRuntime) {
    assert.equal(decide(withTelegram, telegramFiles).noQueuedDeliveryAuthorized, true);
    assert.throws(() => decide(withTelegram, files), /Existing automation review/u);
    for (const key of ['telegramStateSHA256', 'telegramWrappedKeySHA256']) {
      assert.throws(() => decide(withTelegram, { ...telegramFiles, [key]: '0'.repeat(64) }), /Existing automation review/u);
    }
    for (const [key, value] of [['version', 2], ['schemaValidated', false], ['enabled', true], ['tokenConfigured', true], ['profileMatches', false],
      ['hasBinding', true], ['pairingPending', true], ['inbox', 1], ['outstandingOutbox', 1], ['approvals', 1]]) {
      assert.throws(() => decide({ ...withTelegram, telegram: { ...telegram, [key]: value } }, telegramFiles), /Existing automation review/u);
    }
  } else assert.throws(() => decide(withTelegram, telegramFiles), /Existing automation review/u);
  if (target === minecraftCompanionRuntime) {
    // A mutually matching review/on-disk hash is insufficient when the old
    // binary is not the exact already-installed extensions package.
    for (const wrongPrevious of [qqWebBudgetRuntime.asarSHA256, costRuntime.asarSHA256, 'f'.repeat(64)]) {
      assert.throws(() => decide({ ...review, previousAppASARSHA256: wrongPrevious },
        { ...files, previousAppASARSHA256: wrongPrevious }), /Existing automation review/u);
    }
    for (const key of Object.keys(minecraftCompanionRuntime)) {
      assert.throws(() => assertReviewedRetainedAutomation(c, { ...fixture.runtime, [key]: '0'.repeat(64) }, review, files, fixture.now), /Existing automation review/u);
    }
  }
  assert.deepEqual({ c, review, files }, before);
});
const rejectedFutureCases = [
  ['absent review', f => { f.review = undefined; }], ['null review', f => { f.review = null; }],
  ['not read only', f => { f.review.readOnly = false; }], ['changed source copy', f => { f.review.sourceUnchanged = false; }],
  ['secret-reading report', f => { f.review.providerSecretValuesRead = true; }], ['instruction-exporting report', f => { f.review.instructionTextExported = true; }],
  ['wrong review operation', f => { f.review.operation = 'edited'; }], ['failed compatibility', f => { f.compatibility.verdict = 'FAIL'; }],
  ['compatibility changed copy', f => { f.compatibility.sourceUnchangedDuringRead = false; }], ['projected compatibility write', f => { f.compatibility.projectionOnly.noProjectionCommitted = false; }],
  ['wrong profile hash', f => { f.review.profileSHA256 = '3'.repeat(64); }], ['invalid profile hash even when shared', f => { f.review.profileSHA256 = f.compatibility.files.profile.sha256 = 'bad'; }],
  ['wrong profile path', f => { f.review.profilePath = '/tmp/another-copy'; }], ['relative profile paths', f => { f.review.profilePath = f.compatibility.profilePath = 'relative'; }],
  ['wrong review ASAR', f => { f.review.appASARSHA256 = '0'.repeat(64); }], ['wrong compatibility ASAR', f => { f.compatibility.appASARSHA256 = '0'.repeat(64); }],
  ['wrong runtime ASAR', f => { f.runtime.asarSHA256 = '0'.repeat(64); }], ['unsupported runtime source', f => { f.runtime.sourceSHA256 = chatRoundTwoRuntime.sourceSHA256; }],
  ['unsupported runtime main', f => { f.runtime.mainSHA256 = chatRoundTwoRuntime.mainSHA256; }],
  ['review source mismatch', f => { f.review.runtimeIdentity.build.sourceSHA256 = '0'.repeat(64); }], ['review main mismatch', f => { f.review.runtimeIdentity.mainBundleSHA256 = '0'.repeat(64); }],
  ['compatibility source mismatch', f => { f.compatibility.runtimeIdentity.build.sourceSHA256 = '0'.repeat(64); }], ['compatibility main mismatch', f => { f.compatibility.runtimeIdentity.mainBundleSHA256 = '0'.repeat(64); }],
  ['unpackaged evidence', f => { f.review.runtimeIdentity.isPackaged = false; }],
  ['expired review', f => { f.review.checkedAt = new Date(reviewNow - 30 * 60_000 - 1).toISOString(); }],
  ['future issued review', f => { f.review.checkedAt = new Date(reviewNow + 1).toISOString(); }], ['numeric review time', f => { f.review.checkedAt = reviewNow; }],
  ['invalid review time', f => { f.review.checkedAt = 'invalid'; }], ['nonfinite clock', f => { f.now = Number.NaN; }],
  ['review count mismatch', f => { f.review.enabledCount = 2; }], ['compatibility count mismatch', f => { f.compatibility.automaticPaths.enabledChatCronSchedules = 2; }],
  ['string count', f => { f.review.enabledCount = f.compatibility.automaticPaths.enabledChatCronSchedules = '1'; }],
  ['empty review', f => { f.review.enabledCount = f.compatibility.automaticPaths.enabledChatCronSchedules = 0; f.review.schedules = []; }],
  ['duplicate schedule ID', f => { f.review.schedules.push(globalThis.structuredClone(f.review.schedules[0])); f.review.enabledCount = f.compatibility.automaticPaths.enabledChatCronSchedules = 2; }],
  ['disabled schedule', f => { f.review.schedules[0].enabled = false; }], ['cancelled schedule', f => { f.review.schedules[0].cancelledAt = '2026-11-02T12:00:00.000Z'; }],
  ['invalid ID', f => { f.review.schedules[0].id = 'bad'; }], ['invalid session ID', f => { f.review.schedules[0].sessionId = 'bad'; }],
  ['invalid provider ID', f => { f.review.schedules[0].providerId = 'bad'; }], ['inactive session', f => { f.review.schedules[0].sessionActive = false; }],
  ['disabled provider', f => { f.review.schedules[0].providerEnabled = false; }], ['invalid schedule hash', f => { f.review.schedules[0].scheduleSHA256 = 'bad'; }],
  ['zero revision', f => { f.review.schedules[0].revision = 0; }], ['string revision', f => { f.review.schedules[0].revision = '1'; }],
  ['pending run', f => { f.review.schedules[0].pendingRuns = 1; }], ['string pending run count', f => { f.review.schedules[0].pendingRuns = '0'; }],
  ['catch-up policy', f => { f.review.schedules[0].missedPolicy = 'run-once'; }], ['already due marker', f => { f.review.schedules[0].dueNow = true; }],
  ['invalid next time', f => { f.review.schedules[0].nextRunAt = 'invalid'; }], ['numeric next time', f => { f.review.schedules[0].nextRunAt = reviewNow + 3_600_000; }],
  ['already due timestamp', f => { f.review.schedules[0].nextRunAt = new Date(reviewNow).toISOString(); }],
  ['inside safety window', f => { f.review.schedules[0].nextRunAt = new Date(reviewNow + 15 * 60_000 - 1).toISOString(); }],
  ['invalid timezone', f => { f.review.schedules[0].timezone = 'Unavailable/Timezone'; }], ['invalid expression', f => { f.review.schedules[0].expression = '*'; }],
  ['unknown capability', f => { f.review.schedules[0].allowedCapabilities.push('system.exec'); }], ['duplicate capability', f => { f.review.schedules[0].allowedCapabilities.push('time.read'); }],
  ['missing capability grant', f => { f.review.persistentGrants.pop(); }], ['temporary grant scope', f => { f.review.persistentGrants[0].scope = 'session'; }],
  ['expired grant', f => { f.review.persistentGrants[0].expiresAt = new Date(reviewNow - 1).toISOString(); }],
  ['missing expiry field', f => { delete f.review.persistentGrants[0].expiresAt; }], ['duplicate matching grant', f => { f.review.persistentGrants.push({ ...f.review.persistentGrants[0] }); }],
];
for (const [name, mutate] of rejectedFutureCases) test(`future cron rejects ${name}`, () => {
  const fixture = futureCronFixture(); mutate(fixture); assert.throws(() => futureDecision(fixture), /Future cron review|Automatic work/u);
});
for (const [name, mutate] of rejectedFutureCases) test(`Minecraft future cron retains rejection of ${name}`, () => {
  const fixture = minecraftFutureFixture(); mutate(fixture); assert.throws(() => futureDecision(fixture), /Future cron review|Automatic work/u);
});
for (const [name, mutate] of rejectedFutureCases) test(`privacy/efficiency future cron retains rejection of ${name}`, () => {
  const fixture = privacyEfficiencyFixture(); mutate(fixture); assert.throws(() => futureDecision(fixture), /Future cron review|Automatic work/u);
});
for (const [key, value] of Object.entries(stopped).filter(([key]) => key !== 'enabledChatCronSchedules')) {
  test(`future cron still requires typed ${key}`, () => {
    const fixture = futureCronFixture(); delete fixture.compatibility.automaticPaths[key]; assert.throws(() => futureDecision(fixture));
    fixture.compatibility.automaticPaths[key] = typeof value === 'boolean' ? 'false' : '0'; assert.throws(() => futureDecision(fixture));
    if (!['proactiveEnabled', 'proactiveDue', 'loginItemRequestedInSettings'].includes(key)) {
      fixture.compatibility.automaticPaths[key] = typeof value === 'boolean' ? true : 1; assert.throws(() => futureDecision(fixture));
    }
  });
}
test('future cron recheck rejects a previously valid review after copy work consumes the safety margin', () => {
  const fixture = futureCronFixture(); fixture.review.schedules[0].nextRunAt = new Date(reviewNow + 20 * 60_000).toISOString();
  assert.doesNotThrow(() => futureDecision(fixture));
  fixture.now = reviewNow + 5 * 60_000 + 1; assert.throws(() => futureDecision(fixture));
});
test('future cron accepts the exact 15-minute safety boundary', () => {
  const fixture = futureCronFixture(); fixture.review.schedules[0].nextRunAt = new Date(reviewNow + 15 * 60_000).toISOString();
  assert.doesNotThrow(() => futureDecision(fixture));
});
for (const args of [
  ['--future-cron-review=relative'], ['--future-cron-review=/tmp/review.json'],
  ['--future-cron-review=/tmp/review.json', '--app=/tmp/candidate.app', '--compatibility-report=relative'],
  ['--future-cron-review=/tmp/review.json', '--app=/tmp/candidate.app', '--compatibility-report=/tmp/compatibility.json'],
  ['--future-cron-review=/tmp/review.json', '--app=/tmp/candidate.app', `--expected-asar=${costRuntime.asarSHA256}`, '--compatibility-report=/tmp/compatibility.json', '--source-profile=/tmp/migration'],
]) test(`future cron CLI refuses incomplete or migration mode ${args.join(' ')}`, () => {
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./install-local-macos.mjs', import.meta.url)), ...args], { stdio: 'pipe' }),
    error => /requires absolute|requires an absolute|migration is a separate/u.test(error.stderr.toString()));
});

test('only the exact build reviewed with an owner-enabled diary may keep it', async () => {
  const { reviewedDiary } = await import('./install-cutover-policy.mjs');
  const consoleLayout = { sourceSHA256: 'e7922cc62a256d4a1c0bb41f9c4d6ef7a699141fbe3ef48c2fdaab763f2c2bbb', mainSHA256: '1c6b93c90e7e8bc6b367cd21243fe186abbfc6b5f97f044ac267e5bd16da1de0', asarSHA256: '9556dd7e2efabd337d6b4e318fb4aa15c72940b290e32e3ec55ed856e8abee3f' };
  assert.equal(reviewedDiary(consoleLayout), true);
  assert.equal(reviewedDiary({ ...consoleLayout, asarSHA256: 'b40422892402a619796da7cfc05950e4ad5189841d643ccc1770cb65d2a2c6fb' }), false);
  assert.equal(reviewedDiary({ sourceSHA256: 'bfed33bb865bec128638df56dbfdbafef7ac8db83bfcac8005f3028351bc3cdd', mainSHA256: '602d8ccdf5077d3c381b6537752df5f8fc0827bb491a2f7769757a1dd2bee2c3', asarSHA256: 'b40422892402a619796da7cfc05950e4ad5189841d643ccc1770cb65d2a2c6fb' }), false);
  assert.equal(reviewedDiary({ sourceSHA256: '65e7d3cad8d569f46f0ce832f98de7b7bedb690dbe1f6524efe147b33420b1f5', mainSHA256: '4a1e6c57a1a6e2d01e5c99a489ea8e73bcf02b272900b06b8cf8af95fde6ce99', asarSHA256: '1d5221fb7d22e23627b518512fb3001eea4c2b7b7b1a02166e1a83662f16ec20' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: '65e7d3cad8d569f46f0ce832f98de7b7bedb690dbe1f6524efe147b33420b1f5', mainSHA256: 'bf705db4037762d880824571bfd284105c6c78a7c3d5768efd588ed4fcc93db7', asarSHA256: 'b21b1e6d726144cc9751bec1457e4be26a8675fb4cecfb5194bed13075f2e8b8' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: 'a50ee11c032b53c589d813a32bc6999c75a0c119a01063db2d461006362a2292', mainSHA256: '7b7b90c43501b75c70574bfd9962d99a409b23bdc35e22927836c608d528466d', asarSHA256: '25bbe6057fa2c7a9490ac0733be53a2047e214ba7801a16d0841436fbce1cd80' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: '82966b0746aef697e4901b53c694d14656b06abf835f57fabd937fb0a2b849f8', mainSHA256: '646241c7557b9dcf1cdbd3900458d168e24ef07742bbc28b790a80e0e8fbe861', asarSHA256: 'f4ce347d5db4aaa99d3278b730a75092823c6d4f502610f249eb12e458dc8664' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: '60c07c571aea86dbd96e9a46f16c3146087c19ca50e36b20033eb8b10107451a', mainSHA256: '00db700e21321c0d8edc88aeea7b793612437088fd7fca76feb40b098bc66b0a', asarSHA256: 'e241a966ec8589b8ed60d98b761154fb24d0dc4a478466c3779a315c08072e52' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: 'bfec7750e36104bcb9489cd802a7b445a46491164a68d813fa9ef0ec34ebd749', mainSHA256: '356bab571b1bcd836aead1c31f2757820ccb607b8e8cfa8425164c2d05ff5c5d', asarSHA256: '9b1ec160418eb83ab2f725d131733b02d7c965eda0bf73e01942a98cd11f04a8' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: 'd20d3713c214720022be9197aa34d2e7295eacc90e3363b231f27f89e2020138', mainSHA256: '2f2ea8abe8c4bdb67fdbe27ec80d2c56d3b774f3ddbb479c67d52c69f83c155f', asarSHA256: '0256191a5ec20f2bee0072541d991132ac052e0c7118c1ec1b74633324db2058' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: 'd20d3713c214720022be9197aa34d2e7295eacc90e3363b231f27f89e2020138', mainSHA256: 'bf2b6f5d0a608d121e75b2f6ae6c6d65537c08feb90b40924d98e3b833b14285', asarSHA256: '7a84d32b135cfef7e1751ce56a856e04ad090d8699c59337d51ad67ce5f87095' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: '0249396473f335828767119907fcbb5734d7f1887f9a000605f233d2abb0ed4b', mainSHA256: 'd12db460841ce054276b6b79a42083534fa1086795f4d3dc4328ea6adfc755d2', asarSHA256: 'd592fdfcfcdd8dad529ce4b5fe77ff3aa422ee59e013178c37e936469509e775' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: 'a41f48dcc949ddf7eb4b62f4a46fd57ace9223136292b6f947411b1f4a87de5a', mainSHA256: '39f71cea22029f8c8e8508b9e9ea79d8fc8dc90351c1bbdbe220a524a17877d3', asarSHA256: 'dd607b7f2d32a0d0bcfbf738e0e416a0ed340db5556f18e428023bde196c2d99' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: 'a41f48dcc949ddf7eb4b62f4a46fd57ace9223136292b6f947411b1f4a87de5a', mainSHA256: '1d48bc9b6392456b132f2105cedf1352e6029c6fd64acab97eccefe9e10d4f04', asarSHA256: '39b68f3962367a1275dddd3e214b9e2dc92ee7f63623a3044397397bb2ef1ab2' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: '8b1f369763ccee8554be0cc7150b2f8cdbd69e36b3bfc0e5d6b9151dc378288c', mainSHA256: '1faca8dee8a7ef6edad0222dd261c13f134b058103faf8364ab821f2d11d9278', asarSHA256: 'ecb5ac22ea8f693966ba721df277af1a49b14563008ff47b07d04cc5bd42c0ec' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: '93e5da9804db6b328f121f3ea85eb7b2e1d403e8973f194946e4d5832a6aeef9', mainSHA256: 'd4435d8558cfaf468b374cae05f6c04132dfabb39405a855e49d5db3df6bb2b9', asarSHA256: 'c4624292b62ee85caa4019600684e70434b6d498a18c4de7a1752670bb4d5ad7' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: '9aace9f1672ef7199d1fda389527b4ea0bf1213620e8860575e57c05cff56644', mainSHA256: '5c10a4121d3ee077cc56b5490c406dfda680c65d5b556ea92f4f272b46222bfe', asarSHA256: '6ee9408bfc3205432da441b9376168c287f77e61ca4fae122650d6efc4576475' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: '5e866227b8833ecfac3a136fd867029261a4fcfb4e0ad70d78630e50b6da0ade', mainSHA256: 'b61398f3af931e75be0784d790e32c2555c81b250f6a4acff12e1b73f0118af7', asarSHA256: '9acae22086eeb8c33d8e438b81ca2835dccad9b58f2afdf5d9e2a4ecaab5e88c' }), true);
  assert.equal(reviewedDiary({ sourceSHA256: 'ac688d9806c1ff5383c3dfc2990aba7bd58adbe1e625ba65e03634f123592751', mainSHA256: 'bb0602405e9b10448d6260b9df407119d90640792a2bfaebd36e1a3e1b2bfa26', asarSHA256: '2962c2e1cd39739828413b7d7bfff114cbf28fa5e9010645575dc4db75456743' }), true);
  assert.equal(reviewedDiary({}), false);
});
