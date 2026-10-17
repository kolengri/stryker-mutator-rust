// Independently captured from published Core 10.0.0 under Bun 1.4.3.
// Source-file identity supplements, rather than replaces, live descriptor pins.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const bunPins = {
  "2657066820dc4890140032871cc202a362110761a443bbcf807be714405e8c03": "6f4c674429eaa1e3ae63d8a5dd3bb6972c2b3f4485ac1f72243517dad047846d",
  "f4a222cf55367feae1cb3ce3328c45ebb8952e8934de35894cf083db089508b5": "26d1d78df3005dca067bf856f2f64fcf9c91c5ecd6076811a1aaf8525d3a832e",
  "57d2054ef4e95539d7df17bfc6e0ed649ab5b667ea17fe56cf0f31f8f42ddcf3": "d48afcb9fdb7197edafdb7a12cee8de327aa80bb586df6a11de11e202cb12bad",
  "7994dffd8c5ae701f0371f18c7a7ae82df171032b7f3cb6b59d79b4b152a6464": "3baa68baf0753529d7771581d08cad21055cbdc4df051d3fa91cc86656cb600b",
  "2586a9f838f5e6a2bda9face3fdecba50400ddba55ab04dfeed06e2c57d6e033": "6c1af402069480fee21d68af959af0dfa5c5dd213a3da483495f3a101563dba0",
  "3dedc27a710d46c49b39611085b643684cf7c8651526ab3218001bd3a98f8cf9": "68dc7b0cc65451c465b67517268b9d162c1f279bbb316c7c492a8b2823c60410",
  "faece2f8a59456b34925388430b0087cc06f36db9ccf576d07de429c4e1d378a": "ce138359a4e0ffe7c5b7b917adde05725a12a259d1178d31067a99a820529f04",
  "ffd8b5e9e4a37796cba7c9db1c9d23090585550424193b6d77cfd070da3e4a6c": "0b9114836d01a79c83628a722eefee8212775204cba278fecd719bc1e7efa2c9",
  "2be186c37980d6b13b360d98797d55ab4c1283264bde5c72c9ea2200c104a325": "afe67edebb85ff07f2b712eb92f6b1292e09a161ad23b62551634acb89ce9e66",
  "18fba3927cdeacc877b37d1020fe73117055eaa18b463ad429ed7b5fd0400ba0": "2ec1283ed5d49fb83d565d719a5ac1ac31f903b1c5cea46322356f47bb3f4d38",
  "37e46094977647abb406c9cb4ddc09608df5f6a4a7eaa93e19d7b2124b34b7cf": "40be23c225dea2dacd54ae8ef9cb478dfc9c0b92eab1501c58c1932da2214b50",
  "15baf343a4b28dfb84a63367cf47e43154c259075ff354c9c1527f9fffcff38f": "fb5c1051eb39448a03632db83a82b1ac4be28e20bad346d2820aa3d0459f3f36",
  "854632bc2e0d156c34e4d4e2914c903f10bdd2adebd3bd2cf21c7bb6faa08ca1": "70c9ddd6eee77261acf684bb7481e5880f327de34b627349ce7b0cf0b59ed725",
  "5e638acac1ec56fba10ddc45c25ad463b4fbd063671bb116926b44036525c31b": "1ebf235c7145244de50a4e6061a0ba0dca98cdc9294ac71ae62c137f08219368",
  "162041f22afee483047233ee9758b6aa9ce2575e015ea17f724ae891880ca28c": "0b6b1943c51a20a2e107487be2ebba3187615e549a60ec1f43f770e81568f6b0",
  "d404022d6c1afbf411366305346377de1a09f79705e520d951c4e0592745893e": "9da1155b2df65dd5dce23c117605f050ae83d611b5d0a70b2cd7b1ebb87d7ee0",
  "74f3b7397bb61843e72dfa283dec19f730992ad27611bbb75d518682ebc4fe5d": "a79d6d0f43114befaa5178a8b8e6a09d818a4d58e8dddfd12560d0188c84eb2f",
  "71244b129c91736bf983888b534a1c8adfd16a0721149e36f416360ad5a5f588": "bedb6e9acb5337306da247296af9d5d6e2681af4f5f492a08e96a6e2293e9fec",
  "1eeb68dab75e25926bb3c65b70363fb6e411d50879e3eea6eb4dd52d21fc5717": "f0fb6b9cbca14aff378bb0178431331d46a44eb0b1ce82ad2a1af2091c29c36b"
};
const sourcePins = {
  "mutants/test-coverage.js": "a16177a8cff7d370d4b11e06c1552ec4d7505f99c7ad4e1005ea9002f123746f",
  "mutants/mutant-test-planner.js": "283bd52f79fcc2b25eab4d7478036b42cd837f9132c4925560d7d5a8171897c5",
  "sandbox/sandbox.js": "144b06ec839103f08ce6272d543c91deea8ccb32529fd86b88cd33c38f599661"
};
const sha = (input) => createHash('sha256').update(input).digest('hex');

export function coreFingerprint(fn, expected) {
  const actual = sha(Function.prototype.toString.call(fn));
  return process.versions.bun
    ? process.versions.bun === '1.4.3' && actual === bunPins[expected]
    : actual === expected;
}

export function qualifyCoreRuntime(packageUrl) {
  if (!process.versions.bun) return;
  if (process.versions.bun !== '1.4.3') throw new Error('Unqualified Bun private-Core runtime');
  for (const [path, expected] of Object.entries(sourcePins)) {
    if (sha(readFileSync(new URL(`./dist/src/${path}`, packageUrl))) !== expected) {
      throw new Error('Replaced or incompatible pinned Core source');
    }
  }
}
