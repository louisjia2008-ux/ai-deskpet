import { isAbsolute, resolve } from 'node:path';

const costRuntime = {
  sourceSHA256: 'f4ab2c51ea557e15c74ce35185d549e8f4d613e23447b47167457f0e32760100',
  mainSHA256: '5ac49ac408280fbd2fb24e0f4951eb12d72ffa52ba35bcb0460d5b8aa4a743e7',
  asarSHA256: 'e6afbe97337067e13788ca017df05bdd11b0812499525ba2483b8af2a4823df6',
};
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

// Owner-authorized latest daily cutover: QQ web-budget continuation, fallback,
// skills and nightly memory. Cron/settings/automatic services match the prior
// daily module structure; nightly is the sole new automatic path, defaults off,
// and must also be observed disabled in the hash-bound stopped-copy review.
const qqWebBudgetRuntime = {
  sourceSHA256: '3a76c7674ddbf2aee04ee86a2dcc1022327f77d0379d182763400f9c52ea5c18',
  mainSHA256: '87d12092061dd77c868147f3c139fcc90a5a14a94291d0c4e02dcc5e56a6c2a2',
  asarSHA256: 'e8be038e4bb35fd24c0bba1d23039c346ecc841ba13c4af03dc76c267167ddeb',
};

// Owner-requested skills/MCP upgrade from qqWebBudgetRuntime. Automatic,
// channel, login and startup policy modules are unchanged; the new browser
// worker starts only from explicit desktop MCP operations. Preserve existing
// authority only with the fresh stopped-copy and exact-artifact reviews below.
const extensionsRuntime = {
  sourceSHA256: '6c53cd7873511086c6bdee758d29b54aa64a1295c55b243d9facb6c785cdf9c2',
  mainSHA256: '6e7ac9bec882d23f01df8a76d9ea09dcfeab17a97a1789edbe7d9ac3dc89bf74',
  asarSHA256: 'abe25850d2e4d350b962d8bd151442446b93e815723a64b2246e1251cb0c03e2',
};

// Owner-authorized basic Minecraft chat upgrade from extensionsRuntime. The
// independent core worker starts only on explicit interactive desktop connect;
// service construction, cron and other channels cannot start Minecraft activity.
// Preserve existing settings only with the same fresh stopped-copy reviews.
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

// Exact owner-requested 2026-11-10 usability cutover. This local cutover policy
// preserves reviewed authority; the new task/QQ queues must be observed empty.
const usabilityRuntime = {
  "sourceSHA256": "f92c98d0e717fdbbf6dc372677943a695702370512102565ac0f3a0ce993e86a",
  "mainSHA256": "a8ef3359c95d77a871e32d0cffadbadded8dad7a57452aa2ee89201bb1c1d322",
  "asarSHA256": "aad7f6ad5eff850e4467c625c4526e7ca7079fb0681f764d6c612fd3effdddc9"
};
const previousRuntime = {
  "sourceSHA256": "c75461d2bf5b711074bd6d07bab55e3d3df4b6803cccfe3996bdc12d584afd4d",
  "mainSHA256": "10c473ead91fe60a40fb1d7ac7e5bf37d8760df801a673c177dd6a9c90337c85",
  "asarSHA256": "443d21713a6f16db002f293ce4f64fb2dcad6e6a8194e6502e1cdce7f3cc1936"
};
// Owner-requested 2026-11-12 redesign batch (chat commands, wider history, cloud connector
// tools, legacy scheduler removed, sandbox VM shell that starts only on an approved command), installed over the usability build under the same gates.
const redesignRuntime = {
  sourceSHA256: '9169e8fcdb086430bd6acded9c99dee918bf0192a488102e5d59da6e38e9cdc8',
  mainSHA256: '6f71580e56302719ad407ee26b0a2d9ded04b3292e6db62aa889771ed2966f83',
  asarSHA256: '6994d4fe8d4e6a3b7ceca7fa5671dfb7153744c87387530ffcccbf45778ff090',
};
// Owner-requested 2026-11-12 memory batch: auto memory and the nightly tidy-up (both on by
// default at the owner's request; each makes model requests on its own), QQ delivery for
// desktop schedules (off until ticked per schedule), regrouped More menu. The retired
// rule-based nightly path stays off in stored data, which the same gate still checks.
const memoryRuntime = {
  sourceSHA256: 'e78892af3f50bc2489ad1ee77fafc76c2a15a8cd9abc15380686b7749725954e',
  mainSHA256: '8de4d249823a9c802aed7a2cc5770fdfb8f2cdd7ceb5caae9e35a7d8b22f0136',
  asarSHA256: '493b6f6a5305a67140a387bac471dcbc3697dbdcc289607b67ab158a339c0ea4',
};
// Owner-authorized installation of the three-batch privacy/efficiency changes.
// The installed memory build matches HEAD's 560-source baseline exactly. Schema,
// startup, scheduling, check-in and channel authority are unchanged; automatic
// memory still starts only after a completed owner turn, with stricter privacy.
// Keep all stopped-copy, supplemental, future-cron and retained-policy checks.
const privacyEfficiencyRuntime = {
  sourceSHA256: '078e7ae206081fe5157fce626effd01c48c19167c8636e012978102a4e423cfc',
  mainSHA256: '9d7b860dad7b8b5c73d08c3a7a8c52e8ec7ffc76f2536ea8aa15377def508977',
  asarSHA256: 'cc687921d76bb6b88eb27dd08f3f49747f4bdff105d64008a5ebabfd6fffc2ed',
};
// The WeChat settings IPC controls the separate, already bound local worker.
// This exact daily build retains the existing schedule and channel checks.
const wechatSettingsRuntime = {
  sourceSHA256: '61af7aae89819d9cdbe967e71ac4317470cbf72d5e06371e24d7ee88b3ad7f0c',
  mainSHA256: 'cb7f1b634cc84c0ee4267c878a5889bf6015fd879c4592503b435d43550ac810',
  asarSHA256: '0ae89aded372043a2edbe82f295ad6514dd9b33b06bbaf3bbca6b713646cce2a',
};
const wechatMultiGroupRuntime = {
  sourceSHA256: '3d5fa48d78642567b8ca8f1c91903f9f4308aa61c6ed675728bdf5832a80930e',
  mainSHA256: '57b8b63ac99355c11e95ed5ca7cedef34b31555ed52988f57bf3a8a81823abfc',
  asarSHA256: '049c5d217c67828850a2bae2207a325dcf0c7db34f72c6570c7762f4d98d58c2',
};
const wechatCloudRuntime = {
  sourceSHA256: '525ce68f2dad8bf9a8bdd17b1c03b99ca61de1438eff1ebfb6b81cc001a1ef9c',
  mainSHA256: '6feab85eebb135e8d61334f4cc4f4de11119b09d290a5367f2314077ff0ddeb5',
  asarSHA256: 'a9123b1af0089616ec1b889a0dfc9b5dac31e4c3ec10f001a985aa3bd387b0f5',
};
const wechatHistoryRuntime = {
  "sourceSHA256": "f7ec8d25087e94f3a87040725d71a6a80f2f2c541c2b1862f40a26f9c8c59059",
  "mainSHA256": "c6d2c956fc81f1a5670e744e1d51ed4913f59933afa3bd677ea99a993d0c46f3",
  "asarSHA256": "c5605bb8de66a236a031f4c939b6997de73a08e91ac9d31c7ad081ae6034438e"
};
const wechatTaskRuntime = {
  "sourceSHA256": "6cdeb2e15d456722f5d3fed8558449d8f4eb107e4a11b010227b3c18f0369e19",
  "mainSHA256": "2caa43e96f86a7a3330f1d8693acdd8283190ca923651e8533722ecf61cdd2f9",
  "asarSHA256": "7ad28baf2cd32e4c64bc22e9ec4fb4cc4b32f0b7cdcc46746c3e60f23a6dc5ad"
};
const wechatTaskReceiptRuntime = {
  "sourceSHA256": "f497d83cb4b5b9c0f0863a54cfc8ac136dd2635a19f1425e0586aafdf3940aa7",
  "mainSHA256": "6d0555070fd4bced670ec5424ae0ecb58ca10747b021077fbc275a91ea8f8350",
  "asarSHA256": "c8bdc0a0347f639f1e940602d81136cb87096d90e7098c8abf79741b37324719"
};
const wechatTaskAuthorityRuntime = {
  "sourceSHA256": "a1c14ae6561c2b99b61af12db385d1fa17dc905cf1b289739ec659ec1d963f5f",
  "mainSHA256": "3830968e86c0ff9827532952ef253e8b2370636bb10682481417b4cf56bb2e8a",
  "asarSHA256": "5a9da1ee498a908e55f1c909bc1dcf07852e795fb27bce4b3a32eea67139938f"
};
const wechatStickerRuntime = {
  "sourceSHA256": "52e89649bf46012aa3d44ff7019a8691c6d44f4eb4fdd2d1d960b9d8c54e323e",
  "mainSHA256": "8de6546ef4d19af600865c11f9c0924d9b00980ea171a86e8b6e60aea2700101",
  "asarSHA256": "4b34e96e69e25dddb681432b0b39d758f1795061ac5dbf1c1bcab6ac6cbcc2b8"
};
// WeChat daily source merged with desktop chat extensions (owner MCP tools,
// /skill, Obsidian notes). Binary-only; schema and channel authority unchanged.
const chatExtensionsRuntime = {
  "sourceSHA256": "c21bd67ec050a9e51416fc0d91a7bae1a8366cb4dfcd8354bed3c88f3435e50e",
  "mainSHA256": "08ad746a062059e98fcedb6723e9b2142ac8d9c3d1225b788b642956ec650439",
  "asarSHA256": "07a08624ef43e596bdcf87a50ed5c1a82aa9649a3a48491566a07ac64b025624"
};
const wechatDatabaseRuntime = {
  sourceSHA256: 'c6192e7f7a0f21f883a190335e6fc3ae30832f3d2c0e6682bdf1b44711ee46d2',
  mainSHA256: '2500750cb2244891f455a13eef5c4f072143f8cbde9065c01e2e3d6ea73a24ec',
  asarSHA256: 'e9f5e01318132c2baf89a04c9deddddf4075c2918f122802701ef437f6476318',
};
const wechatDatabaseQuoteRuntime = {
  sourceSHA256: 'c6192e7f7a0f21f883a190335e6fc3ae30832f3d2c0e6682bdf1b44711ee46d2',
  mainSHA256: 'b9a0d474537c44c7d8d0a494be6fba14ed9055da5a725e60f8715c8ecdd0b898',
  asarSHA256: '2980ea06e8514e5093967120c20fa6bb31d0636ef6f6d1d22c156b574181c557',
};
const wechatAssistantMomentsRuntime = {
  sourceSHA256: '90421406a1b909b4589d287f0917bd3a585a5fa61b6de4413a339dbc5333e95a',
  mainSHA256: '8a26ab488b2e749058b7ebc14e4a535e8c79a5427afcb8efe333f42cbcd91055',
  asarSHA256: '121250d83297bfde820df6545822eddac831df8eb540da4db181dfe21d8dd83e',
};
const wechatQuoteCleanupRuntime = {
  sourceSHA256: '8dec5985194df17b311c39283b3bafd38a4ec43d82832728762b0000459b962b',
  mainSHA256: '7daf20bf6cda26a705a59321775aa381e70bba5dbbd9e21bbfe9e65cb5f07cf5',
  asarSHA256: 'd1dae46e2eeed44033dc65ecca1bdfca3798bb7cb1b53231a83720b3e78fa5a6',
};
const wechatDatabaseReceiptRuntime = {
  sourceSHA256: '8dec5985194df17b311c39283b3bafd38a4ec43d82832728762b0000459b962b',
  mainSHA256: '16b2ea69ea8c391cbc034b90936dcd48be689aef9f9c1622a22019d93a4f9f42',
  asarSHA256: 'b16f284fbacabd38312643607cd989b55a3a82e67097eaac39dcb27d4541c182',
};
const wechatGroupRulesRuntime = {
  sourceSHA256: '4c4fe790958bbf3f0f2385bbd14b15b5448e4c38dcb9d131e3f57959930a7eda',
  mainSHA256: '14f9071db654ce53d6bf0f956c8043f820bec68407c06ef49e89e019c619cee8',
  asarSHA256: 'c0ce00645f7ff042c60734375feffb390b1ffbe07cb1589641da1667052594fd',
};
const wechatGroupWebRuntime = {
  sourceSHA256: 'e99e0f339d88471d85f12fc6545fa5449c30924d4fd94e02d69a174434977e54',
  mainSHA256: '65cb20634a55d5f894cc5e838d2126b5e9f6787b27e26a0861753b8ec29240a3',
  asarSHA256: '325aa880a0290e703177f079a5a5d2d7850a191e60eadd19d8a4eb0cd685ab92',
};
const wechatGroupWebReceiptRuntime = {
  sourceSHA256: '62085fa4eb2365d0045dda337cb7f5da3c0ecc0f41ce8d720c4718fb378c40cb',
  mainSHA256: '6a1ec1b681d266ebc68505c4a18d4c5c78af14cda7ff30232b20fa15e449f14e',
  asarSHA256: '1a5da858cbe48ff1b6d9a148da94ae541af6153331c8c4240e96eb7183522598',
};
const backgroundHealthRuntime = {
  sourceSHA256: 'c8af9d1b3cd1d78f600abbfff506d605eb7a91edd048f3762c624e0dcbc87430',
  mainSHA256: 'dcdea007a1a0bc8158dd9ed3e1a243dd67711e47db22c7e0f4edbda57c2402c0',
  asarSHA256: 'fd3c9f5d699d1508b9ee73f9093b3e5d04a6dcaecdaa06c7b4b9e07dd2794d0b',
};
// First build signed by the local "DeskPet Local Signing" certificate instead of ad hoc.
const certificateSignedRuntime = {
  sourceSHA256: 'bc92d9f512463d38954a483b7c6079c2ca0ec7e7ef2ba4c17b7dca6877ceabde',
  mainSHA256: '620d3b90100493ba509e309f1ab569c3976af6afce9ae1f100dffaec8e91c739',
  asarSHA256: '210ecd11957d86a527d31a79183471aa964147cb9c0c919be0e45b8377c55e65',
};
const characterSheetRuntime = {
  sourceSHA256: '6f47b4f858762c16edccfb929db887929d9b493354f22b99a128b128c5278bb5',
  mainSHA256: '798f6c2360ad6be5f22022aa029cd183ce2b613863130f50d35c1195c12dbdc1',
  asarSHA256: 'eec6eaaba548c66ec9e427c3dc9eea1b50c14c85f8d0bd95d8d831ee7d3f11b7',
};
const personaSettingsRuntime = {
  sourceSHA256: '4781c763640c536dd5e6781ecb5f5ef6864d02e84cafd533b46f359c74bf3c72',
  mainSHA256: '42eb6e667c37058ce128d13cbde520ec25db974ec033a9aad58af8ab7977fd75',
  asarSHA256: 'df2115b86b57317fceb5c7eed1d3174660c94e9f47403ac5f3e5a3b49105ea2c',
};
const localVoiceRuntime = {
  sourceSHA256: 'c4f681ce61af5112b8496f6969e6f641f2ce8fd3e7023f12351443a154589092',
  mainSHA256: 'f4f858515a64232c93ad0871057b2b15e9894ddbea352c02ba9d5a0a28f92e20',
  asarSHA256: 'e069ece917cff606d6a185ce6f4fe6e3d4e40055131eb33560db412e00bc39b9',
};
const wechatVoiceRuntime = {
  sourceSHA256: '9b4845e27773333e8ab3e70551d5039c48e3e5e515e1b7540f2ef64404483b9d',
  mainSHA256: '45db77976e68e0ced5d2fd03d232741f81bf01763a921ec09d4c6015d11acbac',
  asarSHA256: '6cea38bcdcfc70dc94ab230d821411839f8227ae8e1f3eae25af965582081389',
};
const voiceAuthorityRuntime = {
  sourceSHA256: '9b4845e27773333e8ab3e70551d5039c48e3e5e515e1b7540f2ef64404483b9d',
  mainSHA256: '1bc8dc39ac84ccae31a73771de25f70b789eb9abb846bc9df10753b569bee899',
  asarSHA256: 'f5130fba148269017ef77965620ed969beba234cd23ceae638319c633911c000',
};
const queueResilienceRuntime = {
  sourceSHA256: '5fd048dfce66716b0eaad2bf86916a59e194c3cd24ab373c7daec41e8b9bf1b8',
  mainSHA256: '49b55ef135d52b99ba06d2d799bf2b8795415e4852a90593884bbcc97f52a78d',
  asarSHA256: '225d8d5cfbee0e9b62a09b75a71b6e8d78e01615649e3aa5ffc76bb403628072',
};
const companionRenweiRuntime = {
  sourceSHA256: 'eb248c60c0651437c5203bb295b47aeb6786b06aac79ef2bb8a8833ec20bbb27',
  mainSHA256: 'b71189ef5b5b5834a8c7ba21ae53954b4ea8a4e07667d6b8c1449dd00df33fef',
  asarSHA256: '53d3e33973657c357cac7d3361570d330898bb28bc518e4ab77b0e35e52151d5',
};
const companionIdentityRuntime = {
  sourceSHA256: 'bfed33bb865bec128638df56dbfdbafef7ac8db83bfcac8005f3028351bc3cdd',
  mainSHA256: '602d8ccdf5077d3c381b6537752df5f8fc0827bb491a2f7769757a1dd2bee2c3',
  asarSHA256: 'b40422892402a619796da7cfc05950e4ad5189841d643ccc1770cb65d2a2c6fb',
};
const consoleLayoutRuntime = {
  sourceSHA256: 'e7922cc62a256d4a1c0bb41f9c4d6ef7a699141fbe3ef48c2fdaab763f2c2bbb',
  mainSHA256: '1c6b93c90e7e8bc6b367cd21243fe186abbfc6b5f97f044ac267e5bd16da1de0',
  asarSHA256: '9556dd7e2efabd337d6b4e318fb4aa15c72940b290e32e3ec55ed856e8abee3f',
};
const consolePolishRuntime = {
  sourceSHA256: '65e7d3cad8d569f46f0ce832f98de7b7bedb690dbe1f6524efe147b33420b1f5',
  mainSHA256: '4a1e6c57a1a6e2d01e5c99a489ea8e73bcf02b272900b06b8cf8af95fde6ce99',
  asarSHA256: '1d5221fb7d22e23627b518512fb3001eea4c2b7b7b1a02166e1a83662f16ec20',
};
const drawerFixRuntime = {
  sourceSHA256: '65e7d3cad8d569f46f0ce832f98de7b7bedb690dbe1f6524efe147b33420b1f5',
  mainSHA256: 'bf705db4037762d880824571bfd284105c6c78a7c3d5768efd588ed4fcc93db7',
  asarSHA256: 'b21b1e6d726144cc9751bec1457e4be26a8675fb4cecfb5194bed13075f2e8b8',
};
const doctorRuntime = {
  sourceSHA256: 'a50ee11c032b53c589d813a32bc6999c75a0c119a01063db2d461006362a2292',
  mainSHA256: '7b7b90c43501b75c70574bfd9962d99a409b23bdc35e22927836c608d528466d',
  asarSHA256: '25bbe6057fa2c7a9490ac0733be53a2047e214ba7801a16d0841436fbce1cd80',
};
const wechatSettingsTabsRuntime = {
  sourceSHA256: '60c07c571aea86dbd96e9a46f16c3146087c19ca50e36b20033eb8b10107451a',
  mainSHA256: '00db700e21321c0d8edc88aeea7b793612437088fd7fca76feb40b098bc66b0a',
  asarSHA256: 'e241a966ec8589b8ed60d98b761154fb24d0dc4a478466c3779a315c08072e52',
};
const wechatFollowupsRuntime = {
  sourceSHA256: '0249396473f335828767119907fcbb5734d7f1887f9a000605f233d2abb0ed4b',
  mainSHA256: 'd12db460841ce054276b6b79a42083534fa1086795f4d3dc4328ea6adfc755d2',
  asarSHA256: 'd592fdfcfcdd8dad529ce4b5fe77ff3aa422ee59e013178c37e936469509e775',
};
const knowledgeVaultRuntime = {
  sourceSHA256: 'a41f48dcc949ddf7eb4b62f4a46fd57ace9223136292b6f947411b1f4a87de5a',
  mainSHA256: '39f71cea22029f8c8e8508b9e9ea79d8fc8dc90351c1bbdbe220a524a17877d3',
  asarSHA256: 'dd607b7f2d32a0d0bcfbf738e0e416a0ed340db5556f18e428023bde196c2d99',
};
const guestReaderStdinRuntime = {
  sourceSHA256: 'a41f48dcc949ddf7eb4b62f4a46fd57ace9223136292b6f947411b1f4a87de5a',
  mainSHA256: '1d48bc9b6392456b132f2105cedf1352e6029c6fd64acab97eccefe9e10d4f04',
  asarSHA256: '39b68f3962367a1275dddd3e214b9e2dc92ee7f63623a3044397397bb2ef1ab2',
};
const doctorV2Runtime = {
  sourceSHA256: '8b1f369763ccee8554be0cc7150b2f8cdbd69e36b3bfc0e5d6b9151dc378288c',
  mainSHA256: '1faca8dee8a7ef6edad0222dd261c13f134b058103faf8364ab821f2d11d9278',
  asarSHA256: 'ecb5ac22ea8f693966ba721df277af1a49b14563008ff47b07d04cc5bd42c0ec',
};
const doctorOwnerSelfTestRuntime = {
  sourceSHA256: '93e5da9804db6b328f121f3ea85eb7b2e1d403e8973f194946e4d5832a6aeef9',
  mainSHA256: 'd4435d8558cfaf468b374cae05f6c04132dfabb39405a855e49d5db3df6bb2b9',
  asarSHA256: 'c4624292b62ee85caa4019600684e70434b6d498a18c4de7a1752670bb4d5ad7',
};
const digestHeartbeatBirthdayRuntime = {
  sourceSHA256: '9aace9f1672ef7199d1fda389527b4ea0bf1213620e8860575e57c05cff56644',
  mainSHA256: '5c10a4121d3ee077cc56b5490c406dfda680c65d5b556ea92f4f272b46222bfe',
  asarSHA256: '6ee9408bfc3205432da441b9376168c287f77e61ca4fae122650d6efc4576475',
};
const minecraftDedicatedRuntime = {
  sourceSHA256: '5e866227b8833ecfac3a136fd867029261a4fcfb4e0ad70d78630e50b6da0ade',
  mainSHA256: 'b61398f3af931e75be0784d790e32c2555c81b250f6a4acff12e1b73f0118af7',
  asarSHA256: '9acae22086eeb8c33d8e438b81ca2835dccad9b58f2afdf5d9e2a4ecaab5e88c',
};
const minecraftProxyDownloadRuntime = {
  sourceSHA256: 'ac688d9806c1ff5383c3dfc2990aba7bd58adbe1e625ba65e03634f123592751',
  mainSHA256: 'bb0602405e9b10448d6260b9df407119d90640792a2bfaebd36e1a3e1b2bfa26',
  asarSHA256: '2962c2e1cd39739828413b7d7bfff114cbf28fa5e9010645575dc4db75456743',
};
const sameSelfDoctorV3Runtime = {
  sourceSHA256: '5f92f348e3ec9573cc606c01c727f502a705a493a6e7e820d17a440cc960034b',
  mainSHA256: 'a27031d9231af0d1cc62e848b24a5c06fcde91e439a093952c83d29f6366d5f0',
  asarSHA256: '5a5608877086fad515877421f04c6d037f0c50e97422e362fb020f8331ee69eb',
};
const modelFollowMomentsRuntime = {
  sourceSHA256: 'ef1fce4de3b18e9de6f85a201f912f8f5ea65b6d185ea22cd59ea494559acf78',
  mainSHA256: 'c16f742b61c59e7fa705fc478fa7862a4f8fb549bab3789606d93c9ed8e211a9',
  asarSHA256: '1c22b8c40a4cd5eb94270f666f53573c09d60a163de2764753569b7b9bade464',
};
const momentsDiagnosticsRuntime = {
  sourceSHA256: '47c02aa7f1619d93ad3a11ebf6b96f282a506a04abadfb70a344ca4b0780e7c4',
  mainSHA256: '223e58c28f2f14e3ea9b25b9fe5e5df1c8db89a5d30518394cdb5920a9880a0c',
  asarSHA256: '763b6fbe2b7621f709ccc5e603973cc8994e7eb4726130eb396c383a47d5b37d',
};
const momentsVisibilityRuntime = {
  sourceSHA256: '47c02aa7f1619d93ad3a11ebf6b96f282a506a04abadfb70a344ca4b0780e7c4',
  mainSHA256: '1caf10117592ebeb55d3f319cb33a299dafdd206d01478b184e3d2dca1f3db7f',
  asarSHA256: 'e53d6959fc11ba3f139ca9f8603d35ebe3a46abcbeaab4c48d0ec94bdf1133ac',
};
const groupDigestDeliveryRuntime = {
  sourceSHA256: '63f268a6d9786bea1b06af1122f670c58ce4ad44b3e22d398383b7090f7c1a0d',
  mainSHA256: 'd6309b98a3b4f9f83156740b327ad8c472018df6799b8c62d874bad3415b14ce',
  asarSHA256: '7e999c254ead6e0e5b3b0b5185fddf6814107f0599f83cf58e455834fc6ebd12',
};
const wechatOwnerTextRuntime = {
  sourceSHA256: 'd950ea99fadb7087f3ccc8936ee0040dcb751b837bf4dacc2f905e5af020db41',
  mainSHA256: '4690dcbba940376f435e9b6a767bcb2f13a112e0aadae5ba682ef0b7239d1361',
  asarSHA256: 'd9ee99ffc91e705b3a1112ffb78c1e70652f15f20ebf7efd76248d5553a04fc3',
};
const uxPrinciplesRuntime = {
  sourceSHA256: '5be9a0d357fa73f6733ce6b88fcda1ffad7f1687683a51de481fa39f4d0cbfe7',
  mainSHA256: 'ef380d45eaea898f4b2305762db854a8412dd772dcecfec7f156ce2eae099045',
  asarSHA256: '7737a63d3316cba3dbbd7b9619faebdba1129076bdc3220d1dbe1a094c357456',
};
const uxDeferredRuntime = {
  sourceSHA256: 'd733ce6782f929dca571508fbb39d57459097461a82eba1c8f29db3767ada402',
  mainSHA256: '6d114d68f85ab3cbdf6bbd683b9ddfc89d3f2ed3d245cfe53d0844c79d04b11a',
  asarSHA256: 'c5d074ce3cb2256670cb97f46696224ec8db28c17f4bea1f289ec17654386f39',
};
const recentForgetRuntime = {
  sourceSHA256: 'a12388588e089189ad16c65cea759c53652ee8a7e75e1985e0fb92735a516a0d',
  mainSHA256: '2e62c7fb3dbbbfbafb0dc4232c1b100e46f93abfe50e7b4a2044a2671c288f56',
  asarSHA256: '70a8ee0343c29e6b0755f5f47f048a98b6a9524935b3745901c65992d8059252',
};
const memoryFollowupsRuntime = {
  sourceSHA256: '5caed8c520518e70bf59e0bd534dbadd379b52cc16dfe5c2c382d93d5e4f1268',
  mainSHA256: 'cef70b8f52a849c6497c2576b1ed3153d78c4387c52d37a8eeecc781fa3d304d',
  asarSHA256: '62edaa850169363d595aae387f69719902750c004982ec91b7032764db7ddf96',
};
const wechatProfileWrapRuntime = {
  sourceSHA256: 'd20d3713c214720022be9197aa34d2e7295eacc90e3363b231f27f89e2020138',
  mainSHA256: 'bf2b6f5d0a608d121e75b2f6ae6c6d65537c08feb90b40924d98e3b833b14285',
  asarSHA256: '7a84d32b135cfef7e1751ce56a856e04ad090d8699c59337d51ad67ce5f87095',
};
const wechatVmWaitRuntime = {
  sourceSHA256: 'd20d3713c214720022be9197aa34d2e7295eacc90e3363b231f27f89e2020138',
  mainSHA256: '2f2ea8abe8c4bdb67fdbe27ec80d2c56d3b774f3ddbb479c67d52c69f83c155f',
  asarSHA256: '0256191a5ec20f2bee0072541d991132ac052e0c7118c1ec1b74633324db2058',
};
const wechatReplyTargetsRuntime = {
  sourceSHA256: 'bfec7750e36104bcb9489cd802a7b445a46491164a68d813fa9ef0ec34ebd749',
  mainSHA256: '356bab571b1bcd836aead1c31f2757820ccb607b8e8cfa8425164c2d05ff5c5d',
  asarSHA256: '9b1ec160418eb83ab2f725d131733b02d7c965eda0bf73e01942a98cd11f04a8',
};
const wechatExpansionRuntime = {
  sourceSHA256: '82966b0746aef697e4901b53c694d14656b06abf835f57fabd937fb0a2b849f8',
  mainSHA256: '646241c7557b9dcf1cdbd3900458d168e24ef07742bbc28b790a80e0e8fbe861',
  asarSHA256: 'f4ce347d5db4aaa99d3278b730a75092823c6d4f502610f249eb12e458dc8664',
};
// One reviewed-build manifest drives every exception. Adding a build here is
// still an explicit exact-artifact review, never version/range authorization.
// legacyPair retains the earlier source+main-only contract; all newer builds
// and every cron/retained-automation decision require the full three hashes.
const reviewedRuntimeManifest = [
  { runtime: costRuntime, legacyPair: true, futureCron: true },
  { runtime: scheduledRunRuntime, legacyPair: true, futureCron: true },
  { runtime: chatBatchRuntime, legacyPair: true, futureCron: true },
  { runtime: reliabilityRuntime, legacyPair: true, futureCron: true },
  { runtime: characterRuntime, legacyPair: true, futureCron: true },
  { runtime: interfaceRuntime, legacyPair: true, futureCron: true },
  { runtime: interfaceFixesRuntime, legacyPair: true, futureCron: true },
  { runtime: qqGroupPairingRuntime, legacyPair: true, futureCron: true },
  { runtime: qqDiagnosticsRuntime, legacyPair: true, futureCron: true },
  { runtime: qqSequenceRuntime, legacyPair: true, futureCron: true },
  { runtime: qqMessageIdRuntime, legacyPair: true, futureCron: true },
  { runtime: qqPrivateDeliveryRuntime, futureCron: true },
  { runtime: qqWebBudgetRuntime, previous: qqPrivateDeliveryRuntime, futureCron: true, nightlyDisabled: true },
  { runtime: extensionsRuntime, previous: qqWebBudgetRuntime, futureCron: true, nightlyDisabled: true },
  { runtime: minecraftCompanionRuntime, previous: extensionsRuntime, futureCron: true, nightlyDisabled: true },
  { runtime: attentionRuntime, previous: minecraftCompanionRuntime, futureCron: true, nightlyDisabled: true },
  { runtime: chineseCheckInRuntime, previous: attentionRuntime, futureCron: true, nightlyDisabled: true },
  { runtime: mediaLibraryRuntime, previous: chineseCheckInRuntime, futureCron: true, nightlyDisabled: true },
  { runtime: officialQqImageRuntime, previous: mediaLibraryRuntime, futureCron: true, nightlyDisabled: true },
  { runtime: qqPersonaStickerRuntime, previous: officialQqImageRuntime, futureCron: true, nightlyDisabled: true, dormantTelegram: true },
  { runtime: usabilityRuntime, previous: previousRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: redesignRuntime, previous: usabilityRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: memoryRuntime, previous: redesignRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: privacyEfficiencyRuntime, previous: memoryRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatSettingsRuntime, previous: privacyEfficiencyRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatMultiGroupRuntime, previous: wechatSettingsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatCloudRuntime, previous: wechatMultiGroupRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatHistoryRuntime, previous: wechatCloudRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatTaskRuntime, previous: wechatHistoryRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatTaskReceiptRuntime, previous: wechatTaskRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatTaskAuthorityRuntime, previous: wechatTaskReceiptRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatStickerRuntime, previous: wechatTaskAuthorityRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: chatExtensionsRuntime, previous: wechatStickerRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatDatabaseRuntime, previous: chatExtensionsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatDatabaseQuoteRuntime, previous: wechatDatabaseRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatAssistantMomentsRuntime, previous: wechatDatabaseQuoteRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatQuoteCleanupRuntime, previous: wechatAssistantMomentsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatDatabaseReceiptRuntime, previous: wechatQuoteCleanupRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatGroupRulesRuntime, previous: wechatDatabaseReceiptRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatGroupWebRuntime, previous: wechatGroupRulesRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  // Supersedes the unshipped wechatGroupWebRuntime; installed over the group-rules build.
  { runtime: wechatGroupWebReceiptRuntime, previous: wechatGroupRulesRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: backgroundHealthRuntime, previous: wechatGroupWebReceiptRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: certificateSignedRuntime, previous: backgroundHealthRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: characterSheetRuntime, previous: certificateSignedRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: personaSettingsRuntime, previous: characterSheetRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: localVoiceRuntime, previous: personaSettingsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: wechatVoiceRuntime, previous: localVoiceRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: voiceAuthorityRuntime, previous: wechatVoiceRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: queueResilienceRuntime, previous: voiceAuthorityRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: companionRenweiRuntime, previous: queueResilienceRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  { runtime: companionIdentityRuntime, previous: companionRenweiRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true },
  // The owner enabled the companion diary on the predecessor and approved keeping it for this build (2026-11-16).
  { runtime: consoleLayoutRuntime, previous: companionRenweiRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Layout polish plus official-account articles; the owner asked for it to replace the daily build with the diary still on (2026-11-16).
  { runtime: consolePolishRuntime, previous: consoleLayoutRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // WeChat owner-delivery drawer fix over the polish build, diary still on (2026-11-16).
  { runtime: drawerFixRuntime, previous: consolePolishRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Doctor, private quoted replies and skipped-message records over the drawer fix, diary still on (2026-11-16).
  { runtime: doctorRuntime, previous: drawerFixRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // WeChat expansion (rich messages, inbox, digests, send diagnostics) and the Moments preview fix over the doctor build, diary still on (2026-11-16).
  { runtime: wechatExpansionRuntime, previous: doctorRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Inbox IPC handlers, reply groups in digests and tabbed WeChat settings over the expansion build, diary still on (2026-11-16).
  { runtime: wechatSettingsTabsRuntime, previous: wechatExpansionRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Reply groups from a list, friend replies, 「知道了」 on 运行状态 and the group digest lock wait over the tabbed settings build, diary still on (2026-11-16).
  { runtime: wechatReplyTargetsRuntime, previous: wechatSettingsTabsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Owner bind and remove actions wait for a reply already using the VM, over the reply-targets build, diary still on (2026-11-16).
  { runtime: wechatVmWaitRuntime, previous: wechatReplyTargetsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Profile cards that wrap a long WeChat ID, over the VM-lock wait build, diary still on (2026-11-16).
  { runtime: wechatProfileWrapRuntime, previous: wechatVmWaitRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // 等你处理 follow-ups and reading forwarded chats over the profile-wrap build, diary still on (2026-11-17).
  { runtime: wechatFollowupsRuntime, previous: wechatProfileWrapRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Notes vault: per-folder sharing, note creation, remote private chats and diary copies, over the follow-ups build, diary still on (2026-11-17).
  { runtime: knowledgeVaultRuntime, previous: wechatFollowupsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // WeChat guest reader program over stdin instead of the sudo command line, over the notes vault build, diary still on (2026-11-17).
  { runtime: guestReaderStdinRuntime, previous: knowledgeVaultRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Doctor v2: daily WeChat send self-test, VM health, diagnosis and WeChat 体检, over the stdin guest reader build, diary still on (2026-11-18).
  { runtime: doctorV2Runtime, previous: guestReaderStdinRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Doctor v2 with the daily send self-test in the owner's private chat, over the first doctor v2 build, diary still on (2026-11-18).
  { runtime: doctorOwnerSelfTestRuntime, previous: doctorV2Runtime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Digest resume, doctor acknowledgements, app heartbeat watchdog and birthday/diary context, over the installed doctor v2 build, diary still on (2026-11-18).
  { runtime: digestHeartbeatBirthdayRuntime, previous: doctorV2Runtime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Survey wand construction and the managed local Minecraft world, over the installed digest/heartbeat/birthday build, diary still on (2026-11-20).
  { runtime: minecraftDedicatedRuntime, previous: digestHeartbeatBirthdayRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Local Minecraft runtime downloads through the system proxy, over the installed managed-world build, diary still on (2026-11-20).
  { runtime: minecraftProxyDownloadRuntime, previous: minecraftDedicatedRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Shared owner identity, recent context and mood, doctor v3 auto-repair and the legacy Minecraft engine retired, over the proxy-download build, diary still on (2026-11-21).
  { runtime: sameSelfDoctorV3Runtime, previous: minecraftProxyDownloadRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Feature models follow service defaults and owner WeChat desktop operations queue ahead of polling, over the shared-self build, diary still on (2026-11-21).
  { runtime: modelFollowMomentsRuntime, previous: sameSelfDoctorV3Runtime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Moments step diagnostics and reply-control cleanup over the model-follow build, diary still on (2026-11-21).
  { runtime: momentsDiagnosticsRuntime, previous: modelFollowMomentsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Moments composer visibility OCR fix over the diagnostics build, diary still on (2026-11-23).
  { runtime: momentsVisibilityRuntime, previous: momentsDiagnosticsRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Group digest readiness and delivery diagnostics over the Moments visibility build, diary still on (2026-11-23).
  { runtime: groupDigestDeliveryRuntime, previous: momentsVisibilityRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Owner chat text limit, details detection and send diagnostics over the group digest build, diary still on (2026-11-24).
  { runtime: wechatOwnerTextRuntime, previous: groupDigestDeliveryRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Owner-first UX round plus the committed owner-text and drawer work, over the installed group digest build, diary still on (2026-11-24).
  { runtime: uxPrinciplesRuntime, previous: groupDigestDeliveryRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Deferred owner-first items (memory search, one check-in control, schedules, backup cancel, consolidation list) over the installed UX build, diary still on (2026-11-25).
  { runtime: uxDeferredRuntime, previous: uxPrinciplesRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // The deferred items plus forgotten memories leaving the recent summary and diaries, over the installed UX build, diary still on (2026-11-25).
  { runtime: recentForgetRuntime, previous: uxPrinciplesRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
  // Memory follow-ups (narrower chat commands, owner diary edits stop dependents, durable merge lineage), over the installed forgotten-memory build (2026-11-25).
  { runtime: memoryFollowupsRuntime, previous: recentForgetRuntime, futureCron: true, nightlyDisabled: true, supplemental: true, dormantTelegram: true, diaryEnabled: true },
];
const matchesRuntime = (runtime, reviewed) => Object.entries(reviewed).every(([key, value]) => runtime?.[key] === value);
const exactReviewed = runtime => reviewedRuntimeManifest.find(entry => matchesRuntime(runtime, entry.runtime));
const supplementalQueueNames = ['researchQueued','researchRunning','qqInboundQueued','qqInboundRunning','qqInboundPaused'];
const assertSupplementalInspection = (compatibility, review, fail) => {
  const supplemental = compatibility?.supplementalInspection;
  if (!supplemental || supplemental.operation !== 'read-only-enabled-cron-review'
    || supplemental.profileSHA256 !== compatibility.files?.profile?.sha256
    || supplemental.profileSHA256 !== review?.profileSHA256
    || supplemental.checkedAt !== review?.checkedAt || supplemental.privateTextExported !== false
    || review?.privateTextExported !== false
    || typeof supplemental.nightlyFieldPresent !== 'boolean'
    || supplemental.nightlyDefaultFromExactArtifact !== !supplemental.nightlyFieldPresent) fail();
  const workNames = ['researchQueued','researchRunning','streamingMessages','runningChatTasks','unconfirmedProactivePublications','activeFocus'];
  const channelNames = ['qqQueue','qqReminders','qqInboundQueued','qqInboundRunning','qqInboundPaused','qqCronCount','telegramCronDeliveries'];
  if (workNames.some(key=>supplemental.workCounts?.[key]!==0||review.workCounts?.[key]!==0)
    || channelNames.some(key=>supplemental.channelChecks?.[key]!==0||review.channelChecks?.[key]!==0)
    || supplementalQueueNames.some(key=>compatibility.automaticPaths?.[key]!==0)
    || !Number.isSafeInteger(supplemental.workCounts?.researchResumable) || supplemental.workCounts.researchResumable<0
    || review.workCounts?.researchResumable!==supplemental.workCounts.researchResumable
    || typeof supplemental.channelChecks?.telegramStatePresent!=='boolean'
    || supplemental.channelChecks.telegramStatePresent!==review.channelChecks?.telegramStatePresent) fail();
};

/** An owner-enabled companion diary is a nightly writer of its own: only an exact build reviewed with it may keep it. */
export const reviewedDiary = runtime => exactReviewed(runtime)?.diaryEnabled === true;

/** Fail closed on every automatic path reported by the production copy reader. */
export const assertNoAutomaticWork = (paths, runtime = {}) => {
  const reviewed = exactReviewed(runtime);
  const webBudgetBuild = reviewed?.nightlyDisabled === true;
  const zero = ['queuedJobs', 'possiblyDispatchedJobs', 'enabledSchedules', 'dueSchedules',
    'enabledTextSchedules', 'dueTextSchedules', 'pendingAutomaticTriggers', 'pendingProactiveEvents', 'pendingTimers', 'dueTimers', 'enabledChatCronSchedules', 'pendingChatCronRuns'];
  // Exact reviewed daily build: only EventProactiveService is instantiated;
  // its policy is separate from the stored legacy proactive record. Startup
  // never calls setLoginItemSettings (only the explicit settings IPC does).
  // Preserve those old preferences, without turning them into new permission.
  // Every other/unknown binary retains the conservative all-disabled gate.
  const inertLegacy = [
    ['196cefbe0c446d994a9e4d471f6e527bf668b71ea1f407943c651be49ae0d741', 'a194da25c9b38f81a2d9e8259822307265775f837892a5aeac74781b993a9d8a'],
    // Provider setup diagnostics only; startup/automatic policy/storage inputs
    // are byte-identical to the first reviewed daily build (source-delta.json).
    ['118e9d7815506edb2728f1c56cab3a36a8170a82423aca1bf12c7581b5a82925', '33bfcee8201b70274120718ca8fb16e07572c88b39a3df470b79c780125bb6e1'],
    // Provider proxy transport only; the same startup/storage/automatic policy.
    ['71e953a8e84ab7c7315c6302754821b3b2db5447652014e6fb87b9f8bfaf8aef', '113027f6cb0577394e3b1e96925266961d99bc2e2b3960d538d096a09aa6000d'],
    // P0 token-unit repair and renderer framing; all14 startup/storage/automatic inputs match725f.
    ['92f43355181b125a42cb8525d223ce6d5014e9288c31f6dcda82c2cf84845bcd', 'b93cfceb2b1db6e97e71a88cbff942779ad197732bddfd49e39d78ec45a9da82'],
    // Context capacity, explicit read pages and no-dispatch ledger terminal records.
    // Startup/automatic assembly is unchanged; all active-work counters still gate installation.
    ['3f946e33aac9b47a273a1f150c99b1ac5f2a4bc1d3e619fdfe18d9610816fae4', 'b6dd4defb87d1934007031b3ae4f5986bf6bcb9f9613de26eda40acda9170f55'],
    // Tray PNG only; all other 307 existing build inputs match the context-fix build.
    ['5bad0f46de8db2221740ba12616006a53129524b99dbb8aa1831d9f273dd4c5a', '7d4079681ac6e636920ca8b99610f2e9e632980772b3c50f121ad21def29ca5d'],
    // User-requested Token recording only, plus tray PNG. Startup/automatic
    // assembly and policies match the prior daily build; active work still blocks.
    ['638871fe7655d25d014a6382bd9f8d4946e9c942981453faa8c365e741b6b6d4', 'ba20678ac59070f62a45581b6b5b5dcb14cb04a98bd9362fdbed798a724aeb6d'],
    // Attention reads/acknowledgement, pure-rule observe mode and cost records.
    // Legacy mode stays off; exact-build review confirms no new model work at startup.
    ['60c5e05a72b8978cb0c40accda6f00568fc0333efd2923fed0bd89b8df101d35', '2725114074a4faf096b63844dbff95e112e2ec087b1c4c787fa58796ffc8d780'],
    // Live2D body drag and native position lifecycle only. The generation
    // startup initializer and automatic policies match the attention/observe build.
    ['4582fce7066dded07f21c82643146f157643414b9f25fa387c77b5ca76011443', '271fddf5af7591f4e8dce66b513f11667cb65aef90db928fc9e32e8e7fc4dda8'],
    // Explicit plugin/Responses update: unchanged startup, automatic policies
    // and login-item behavior; plugin constructors do not initiate network work.
    // All active-work counters and new event-generation policy still gate cutover.
    ['0e47495f185982141ecb2dd7f5f243b9d0e79cba654da111644cb6f8001808f7', '223b39d510dc515b272cd7d6db4715e22d040063c380264c6b70617346bf0fff'],
    // Preserve two validated request fields across the provider utility boundary.
    // Startup, automatic execution and storage inputs match the prior reviewed build.
    ['f5635aebf37a45aee322957ffdca44eba1f79dc322f9e7cf8f7d4671d6f1a1d7', '050121f2549fd8de7dcd57523a0443686dbe6ef591388cb9522ce8b60dcfa9d9'],
    // Chat recovery, follow-ups, inline approval, memory relevance and waiting UI.
    // Reviewed startup/automatic assembly and login-item behavior are unchanged;
    // ChatInteractionService starts only with an explicit chat. Active work still blocks.
    ['315aa2c13418c8f8955070032a3934c8f3ce9f8517c7b10f7a1a300305cc4308', '7fc418591634d19ffada3e70054e6400fecd78c8086329bfa3f4f6b329a0c80b'],
    // Reviewed round-two task/history/cron build. Legacy proactive/login intent
    // stays inert; the new cron startup path is separately gated by both cron
    // counters above. Empty startup ticks may save local schema defaults only.
    ['1dda591d1a34af91ec94bd48079f1af24a54d23ad4ee79305688a29ae4c8e350', 'c7795778747c24501a9765d05a518ded8b5cd44e8b3e32149f88c17f81017aea'],
  ].some(([source, main]) => runtime.sourceSHA256 === source && runtime.mainSHA256 === main)
    // This daily package preserves inert legacy preferences. Fresh private QQ
    // care/reminder grants and Telegram enablement have no enabled default.
    || reviewed !== undefined
    || reviewedRuntimeManifest.some(entry => entry.legacyPair && runtime.sourceSHA256 === entry.runtime.sourceSHA256 && runtime.mainSHA256 === entry.runtime.mainSHA256);
  const booleans = ['proactiveEnabled', 'proactiveDue', 'eventProactiveEnabled', 'loginItemRequestedInSettings'];
  const disabled = inertLegacy ? ['eventProactiveEnabled'] : booleans;
  if (!paths || zero.some((name) => paths[name] !== 0) || booleans.some((name) => typeof paths[name] !== 'boolean')
    || disabled.some((name) => paths[name] !== false)
    || (webBudgetBuild && paths.nightlyMemoryEnabled !== false)
    || (reviewed?.supplemental && supplementalQueueNames.some(name=>paths[name]!==0))) {
    throw new Error('Automatic work requires a separate explicit cutover decision; no installation performed.');
  }
  return { exactReviewedRuntime: inertLegacy, activeAutomaticWork: false,
    storedLegacyProactivePreserved: paths.proactiveEnabled, storedLoginIntentPreserved: paths.loginItemRequestedInSettings,
    startupRegistersLoginItem: false, newEventProactiveEnabled: paths.eventProactiveEnabled };
};

/** A separate, explicit decision preserves reviewed future cron entries. It
 * never edits schedules or grants permission, and cannot authorize catch-up. */
export const assertReviewedFutureCron = (compatibility, runtime, review, now = Date.now()) => {
  const fail = () => { throw new Error('Future cron review is missing, stale or does not match this stopped copy and exact artifact; no installation performed.'); };
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
  const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ? Date.parse(value) : Number.NaN;
  const reviewed = exactReviewed(runtime);
  const reviewedRuntime = reviewed?.futureCron ? reviewed.runtime : undefined;
  if (!reviewedRuntime) fail();
  const identityMatches = identity => identity?.build?.sourceSHA256 === reviewedRuntime.sourceSHA256
    && identity?.mainBundleSHA256 === reviewedRuntime.mainSHA256 && identity?.isPackaged === true;
  if (!Number.isFinite(now)
    || !compatibility || compatibility.verdict !== 'PASS' || compatibility.operation !== 'read-only-profile-inspection'
    || compatibility.readOnly !== true || compatibility.sourceUnchangedDuringRead !== true
    || compatibility.compatibleWithCurrentSchema !== true || compatibility.artifactMode !== 'daily' || compatibility.runtimeName !== 'DeskPet Electron'
    || compatibility.providerSecretValuesRead !== false || compatibility.projectionOnly?.pendingRestorePresent !== false
    || compatibility.projectionOnly?.noProjectionCommitted !== true || !identityMatches(compatibility.runtimeIdentity)
    || compatibility.appASARSHA256 !== reviewedRuntime.asarSHA256
    || !review || review.operation !== 'read-only-enabled-cron-review' || review.readOnly !== true || review.sourceUnchanged !== true
    || review.providerSecretValuesRead !== false || review.instructionTextExported !== false
    || !identityMatches(review.runtimeIdentity) || review.appASARSHA256 !== reviewedRuntime.asarSHA256
    || !hash(review.profileSHA256) || review.profileSHA256 !== compatibility.files?.profile?.sha256
    || typeof review.profilePath !== 'string' || !isAbsolute(review.profilePath)
    || typeof compatibility.profilePath !== 'string' || !isAbsolute(compatibility.profilePath)
    || resolve(review.profilePath) !== resolve(compatibility.profilePath)) fail();
  if (reviewed.supplemental) assertSupplementalInspection(compatibility, review, fail);
  const checkedAt = time(review.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 30 * 60_000
    || !Array.isArray(review.schedules) || !Number.isSafeInteger(review.enabledCount) || review.enabledCount < 1 || review.enabledCount > 200
    || review.enabledCount !== review.schedules.length || review.enabledCount !== compatibility.automaticPaths?.enabledChatCronSchedules
    || !Array.isArray(review.persistentGrants)) fail();
  const capabilities = new Set(['web.search', 'web.read', 'workspace.write', 'math.calculate', 'time.read']);
  const ids = new Set();
  for (const schedule of review.schedules) {
    const next = time(schedule?.nextRunAt);
    if (!schedule || !uuid(schedule.id) || ids.has(schedule.id) || !uuid(schedule.sessionId) || !uuid(schedule.providerId)
      || typeof schedule.model !== 'string' || schedule.model.trim() !== schedule.model || schedule.model.length < 1 || schedule.model.length > 240
      || [...schedule.model].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || !Number.isSafeInteger(schedule.revision) || schedule.revision < 1
      || !hash(schedule.scheduleSHA256) || schedule.enabled !== true || schedule.cancelledAt !== null
      || schedule.dueNow !== false || schedule.sessionActive !== true || schedule.providerEnabled !== true || schedule.pendingRuns !== 0
      || schedule.missedPolicy !== 'skip' || !Number.isFinite(next) || next - now < 15 * 60_000
      || typeof schedule.expression !== 'string' || schedule.expression.length > 120 || schedule.expression.trim().split(/\s+/u).length !== 5
      || typeof schedule.timezone !== 'string' || schedule.timezone.length > 100
      || !Array.isArray(schedule.allowedCapabilities) || new Set(schedule.allowedCapabilities).size !== schedule.allowedCapabilities.length
      || schedule.allowedCapabilities.some(capability => !capabilities.has(capability))) fail();
    try { new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format(now); } catch { fail(); }
    for (const capability of schedule.allowedCapabilities) {
      const grants = review.persistentGrants.filter(grant => grant?.capabilityId === capability);
      if (grants.length !== 1 || grants[0].scope !== 'always' || grants[0].expiresAt !== null) fail();
    }
    ids.add(schedule.id);
  }
  // Only this already-reviewed enabled count is removed from the *copy* sent
  // through the unchanged guard. Pending cron and every other path still gate.
  const decision = assertNoAutomaticWork({ ...compatibility.automaticPaths, enabledChatCronSchedules: 0 }, runtime);
  return { ...decision, futureCronPreserved: true, reviewedFutureCron: {
    enabledCount: review.enabledCount, checkedAt: review.checkedAt, validatedAt: new Date(now).toISOString(),
    noImmediateRunAuthorized: true, noCatchUpAuthorized: true, noNewPermissionsGranted: true,
    schedules: review.schedules.map(({ id, revision, scheduleSHA256, nextRunAt, missedPolicy }) => ({ id, revision, scheduleSHA256, nextRunAt, missedPolicy })),
  } };
};

/** Preserve an owner's already-enabled check-in policy on this reviewed upgrade.
 * This does not authorize a new policy, queued delivery, catch-up or test message.
 * The installer supplies fresh on-disk hashes again immediately before swap. */
export const assertReviewedRetainedAutomation = (compatibility, runtime, review, currentFiles, now = Date.now()) => {
  const fail = () => { throw new Error('Existing automation review does not match this stopped profile and exact upgrade; no installation performed.'); };
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const reviewed = exactReviewed(runtime);
  const upgrade = reviewed?.previous ? { current: reviewed.runtime, previous: reviewed.previous } : undefined;
  if (!upgrade
    || !compatibility || compatibility.verdict !== 'PASS' || compatibility.readOnly !== true
    || compatibility.sourceUnchangedDuringRead !== true || compatibility.providerSecretValuesRead !== false
    || compatibility.appASARSHA256 !== upgrade.current.asarSHA256
    || !review || review.operation !== 'read-only-retained-automation-review' || review.readOnly !== true
    || review.preserveExistingOnly !== true || review.sourceUnchanged !== true
    || review.providerSecretValuesRead !== false || review.instructionTextExported !== false
    || review.previousAppASARSHA256 !== upgrade.previous.asarSHA256
    || review.appASARSHA256 !== upgrade.current.asarSHA256
    || review.runtimeIdentity?.isPackaged !== true || review.runtimeIdentity?.mainBundleSHA256 !== runtime.mainSHA256
    || review.runtimeIdentity?.build?.sourceSHA256 !== runtime.sourceSHA256
    || !isAbsolute(review.profilePath ?? '') || review.profilePath !== compatibility.profilePath
    || review.profileSHA256 !== compatibility.files?.profile?.sha256
    || review.wrappedKeySHA256 !== compatibility.files?.wrappedKey?.sha256
    || review.settingsSHA256 !== compatibility.files?.settings?.sha256
    || review.nightlyMemoryEnabled !== false || compatibility.automaticPaths?.nightlyMemoryEnabled !== false
    || review.eventProactiveEnabled !== compatibility.automaticPaths?.eventProactiveEnabled
    || review.eventProactiveEnabled !== true || review.mode !== 'auto'
    || review.hasPersistentAutomationGrant !== true
    || !Number.isSafeInteger(review.policyRevision) || review.policyRevision < 1
    || !hash(review.policySHA256) || !hash(review.grantsSHA256)) fail();
  if (reviewed.supplemental) {
    assertSupplementalInspection(compatibility, review, fail);
    if (compatibility.runtimeIdentity?.isPackaged!==true || compatibility.runtimeIdentity?.mainBundleSHA256!==runtime.mainSHA256
      || compatibility.runtimeIdentity?.build?.sourceSHA256!==runtime.sourceSHA256
      || ['inboundQueued','inboundRunning','inboundPaused'].some(key=>review.qq?.[key]!==0)) fail();
  }
  const checkedAt = Date.parse(review.checkedAt);
  if (!Number.isFinite(now) || !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 30 * 60_000) fail();
  try { new Intl.DateTimeFormat('en', { timeZone: review.timezone }).format(now); } catch { fail(); }
  const q = review.qq, c = review.channelChecks;
  if (!q || !c || q.profileMatches !== true || q.bindingSessionMatches !== true
    || q.privateCareAuthorityMatches !== true || q.remindersAuthorityMatches !== true
    || typeof q.privateCareEnabled !== 'boolean' || typeof q.remindersEnabled !== 'boolean'
    || !hash(q.bindingSHA256) || !hash(q.configSHA256)
    || q.pendingOutbox !== 0 || q.pendingReminders !== 0 || q.pendingConfirmations !== 0 || q.pairingPending !== false
    || c.qqQueue !== 0 || c.qqReminders !== 0 || c.qqCare !== q.privateCareEnabled
    || c.qqCronCount !== 0 || c.telegramCronDeliveries !== 0) fail();
  const expected = { previousAppASARSHA256: review.previousAppASARSHA256, profileSHA256: review.profileSHA256,
    wrappedKeySHA256: review.wrappedKeySHA256, settingsSHA256: review.settingsSHA256,
    qqStateSHA256: q.stateSHA256, qqWrappedKeySHA256: q.wrappedKeySHA256 };
  if (currentFiles?.telegramStatePresent !== c.telegramStatePresent) fail();
  const telegram = review.telegram;
  if (c.telegramStatePresent === true) {
    // This exact upgrade may keep the schema-validated, disabled Telegram store
    // found on the stopped copy. Presence alone cannot authorize startup work.
    if (!reviewed.dormantTelegram || telegram?.version !== 1 || telegram.schemaValidated !== true
      || telegram.enabled !== false || telegram.tokenConfigured !== false || telegram.profileMatches !== true
      || telegram.hasBinding !== false || telegram.pairingPending !== false
      || telegram.inbox !== 0 || telegram.outstandingOutbox !== 0 || telegram.approvals !== 0) fail();
    if (reviewed.supplemental && telegram.validationScope !== 'dormant-state-shape') fail();
    expected.telegramStateSHA256 = telegram.stateSHA256;
    expected.telegramWrappedKeySHA256 = telegram.wrappedKeySHA256;
  } else if (c.telegramStatePresent !== false || telegram != null) fail();
  if (Object.entries(expected).some(([key, value]) => !hash(value) || currentFiles?.[key] !== value)) fail();
  return { retainedAutomationPreserved: true, noNewPermissionsGranted: true, noQueuedDeliveryAuthorized: true,
    policySHA256: review.policySHA256, grantsSHA256: review.grantsSHA256, qqBindingSHA256: q.bindingSHA256,
    checkedAt: review.checkedAt, validatedAt: new Date(now).toISOString(),
    note: 'Existing check-ins may run naturally under their unchanged policy after normal restart.' };
};

/** Names only: this guard never reads a lock, recovery journal or user content. */
export const assertStoppedEntries = (names) => {
  if (names.some((name) => ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'restore-pending.json', 'recovery', '.staging'].includes(name)
    || name.includes('.corrupt-'))) throw new Error('A profile lock or unresolved restore/recovery/staging requires review; no cutover performed.');
};
