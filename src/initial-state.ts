import { fstat } from "node:fs";
import { config } from "./config";
import { subgraphQuery, subgraphQueryPaginated } from "./subgraph";
import { UserList } from "./types";
import {
  getExclusionList,
  getOrCreateUser,
  getSafeOwnerMapping,
} from "./utils";

export const getInitialState = async (startBlock: number, endBlock: number) => {
  console.log("Fetch initial state...");

  // Get all LP token balance
  const balances = await getInitialRaiLpBalances(startBlock);

  console.log(`  Fetched ${balances.length} LP token balances`);
  // Get all debts
  const debts = await getInitialSafesDebt(startBlock, endBlock);

  console.log(`  Fetched ${debts.length} debt balances`);

  // Combine debt and LP balances
  const users: UserList = {};
  for (let bal of balances) {
    const user = getOrCreateUser(bal.address, users);
    user.lpBalance = bal.lpBalance;
    user.raiLpBalance = bal.raiLpBalance;
    users[bal.address] = user;
  }

  for (let debt of debts) {
    const user = getOrCreateUser(debt.address, users);
    user.debt += debt.debt;
    users[debt.address] = user;
  }

  // Remove accounts from the exclusion list
  const exclusionList = await getExclusionList();
  for (let e of exclusionList) {
    delete users[e];
  }

  // Set the initial staking weights
  Object.values(users).map((u) => {
    u.stakingWeight = Math.min(u.debt, u.raiLpBalance);
  });

  // Sanity checks
  for (let user of Object.values(users)) {
    if (
      user.debt == undefined ||
      user.earned == undefined ||
      user.lpBalance == undefined ||
      user.raiLpBalance == undefined ||
      user.rewardPerWeightStored == undefined ||
      user.stakingWeight == undefined
    ) {
      throw Error(`Inconsistent initial state user ${user}`);
    }
  }

  console.log(
    `Finished loading initial state for ${Object.keys(users).length} users`
  );
  return users;
};

const getInitialSafesDebt = async (startBlock: number, endBlock: number) => {
  const debtQuery = `{safes(where: {debt_gt: 0}, first: 1000, skip: [[skip]],block: {number:${startBlock}}) {debt, safeHandler}}`;
  const debtsGraph: {
    debt: number;
    safeHandler: string;
  }[] = await subgraphQueryPaginated(
    debtQuery,
    "safes",
    config().GEB_SUBGRAPH_URL
  );

  // Safe owners mapping
  const owners = await getSafeOwnerMapping(endBlock);

  // We need the adjusted debt after accumulated rate for the initial state
  const accumulatedRate = await getAccumulatedRate(startBlock);

  let debts: { address: string; debt: number }[] = [];
  for (let u of debtsGraph) {
    if (!owners.has(u.safeHandler)) {
      console.log(`Safe handler ${u.safeHandler} has no owner`);
      continue;
    }

    debts.push({
      address: owners.get(u.safeHandler),
      debt: Number(u.debt) * accumulatedRate,
    });
  }

  return debts;
};

const getInitialRaiLpBalances = async (startBlock: number) => {
  const lpTokenBalancesQuery = `{erc20Balances(where: {tokenAddress: "${
    config().UNISWAP_POOL_ADDRESS
  }", balance_gt: 0}, first: 1000, skip: [[skip]], block: {number: ${startBlock}}), { balance, address }}`;
  const balancesGraph: {
    balance: string;
    address: string;
  }[] = await subgraphQueryPaginated(
    lpTokenBalancesQuery,
    "erc20Balances",
    config().GEB_SUBGRAPH_URL
  );

  // We need the pool state to convert LP balance to RAI holdings
  const { uniRaiReserve, totalLpSupply } = await getPoolState(startBlock);

  // RAI LP balance = LP balance * RAI reserve  / total LP supply
  return balancesGraph.map((x) => ({
    address: x.address,
    lpBalance: Number(x.balance),
    raiLpBalance: (Number(x.balance) * uniRaiReserve) / totalLpSupply,
  }));
};

export const getAccumulatedRate = async (block: number) => {
  return Number(
    (
      await subgraphQuery(
        `{collateralType(id: "ETH-A", block: {number: ${block}}) {accumulatedRate}}`,
        config().GEB_SUBGRAPH_URL
      )
    ).collateralType.accumulatedRate
  );
};

export const getPoolState = async (block: number) => {
  const poolState = await subgraphQuery(
    `{uniswapV2Pairs(block: {number: ${block} }, where: {address: "${
      config().UNISWAP_POOL_ADDRESS
    }"}) {reserve0,totalSupply}}`,
    config().GEB_UNISWAP_SUBGRAPH_URL
  );

  const uniRaiReserve = Number(poolState.uniswapV2Pairs[0].reserve0);
  const totalLpSupply = Number(poolState.uniswapV2Pairs[0].totalSupply);

  return {
    uniRaiReserve,
    totalLpSupply,
  };
};
