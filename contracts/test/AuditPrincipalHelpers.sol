// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

interface IRev {
    function stake(address token, uint256 amount) external;
    function withdraw(address token, uint256 amount) external;
    function withdrawDeposit(address token) external;
    function claim(address[] calldata tokens) external;
    function sync(address[] calldata tokens) external;
    function syncAll() external;
}

interface ITok {
    function approve(address s, uint256 a) external returns (bool);
    function transfer(address to, uint256 a) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// @dev A staking integrator (vault, timelock, multisig without a fallback, EIP-7702 delegate without
///      tokenReceived) that only ever deals in the ERC-20 version. It has no tokenReceived and no fallback,
///      so any ERC-223 transfer to it reverts.
contract NoCallbackStaker {
    function stake(address rev, address token, uint256 amount) external {
        ITok(token).approve(rev, amount);
        IRev(rev).stake(token, amount);
    }

    function withdraw(address rev, address token, uint256 amount) external {
        IRev(rev).withdraw(token, amount);
    }
}

/// @dev An auto-compounding integrator: whatever D223 it receives it immediately forwards back to the
///      revenue contract as a deposit, to stake it in a later transaction.
contract ForwardingVault {
    address public rev;
    address public d223;

    constructor(address _rev, address _d223) {
        rev = _rev;
        d223 = _d223;
    }

    function stakeFromDeposit(uint256 amount) external {
        IRev(rev).stake(d223, amount);
    }

    function withdraw(uint256 amount) external {
        IRev(rev).withdraw(d223, amount);
    }

    function tokenReceived(address from, uint256 value, bytes calldata) external returns (bytes4) {
        if (msg.sender == d223 && from == rev) {
            ITok(d223).transfer(rev, value); // re-deposit for later staking
        }
        return 0x8943ec02;
    }
}

/// @dev Recipient that tries every state-changing entry point of the revenue contract from inside the
///      D223 tokenReceived callback that withdraw()/withdrawDeposit() triggers.
contract ReentrantStaker {
    address public rev;
    address public d223;
    address public reward;
    uint8 public mode; // 0 none, 1 withdraw, 2 stake, 3 claim, 4 withdrawDeposit, 5 sync, 6 syncAll
    bool public reentryOk;
    bytes public reentryErr;
    uint256 public callbacks;

    constructor(address _rev, address _d223, address _reward) {
        rev = _rev;
        d223 = _d223;
        reward = _reward;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function deposit(uint256 amount) external {
        ITok(d223).transfer(rev, amount);
    }

    function stakeDeposit(uint256 amount) external {
        IRev(rev).stake(d223, amount);
    }

    function withdraw(address token, uint256 amount) external {
        IRev(rev).withdraw(token, amount);
    }

    function withdrawDeposit() external {
        IRev(rev).withdrawDeposit(d223);
    }

    function tokenReceived(address, uint256, bytes calldata) external returns (bytes4) {
        callbacks++;
        if (mode == 0) return 0x8943ec02;
        uint8 m = mode;
        mode = 0;
        address[] memory toks = new address[](1);
        toks[0] = reward;
        bytes memory data;
        if (m == 1) data = abi.encodeCall(IRev.withdraw, (d223, 1));
        else if (m == 2) data = abi.encodeCall(IRev.stake, (d223, 1));
        else if (m == 3) data = abi.encodeCall(IRev.claim, (toks));
        else if (m == 4) data = abi.encodeCall(IRev.withdrawDeposit, (d223));
        else if (m == 5) data = abi.encodeCall(IRev.sync, (toks));
        else data = abi.encodeCall(IRev.syncAll, ());
        (bool ok, bytes memory err) = rev.call(data);
        reentryOk = ok;
        reentryErr = err;
        return 0x8943ec02;
    }
}

/// @dev Hostile reward token listed by mistake. Modes: 1 revert everything, 2 burn all gas in balanceOf and
///      transfer, 3 return a huge returndata blob from transfer, 4 report an ever-growing balance.
contract EvilRewardToken {
    uint8 public mode;
    uint256 public fake;

    function setMode(uint8 m) external {
        mode = m;
    }

    function balanceOf(address) external view returns (uint256) {
        if (mode == 1) revert('evil');
        if (mode == 2) {
            while (true) {}
        }
        if (mode == 4) return fake;
        return 0;
    }

    function bump(uint256 by) external {
        fake += by;
    }

    function transfer(address, uint256) external view returns (bool) {
        if (mode == 1) revert('evil');
        if (mode == 2) {
            while (true) {}
        }
        if (mode == 3) {
            assembly {
                return(0, 1000000)
            }
        }
        return true;
    }
}
