// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

interface IMarginModuleTakeLoan {
    function takeLoan(uint256 _orderId, uint256 _amount, uint256 _collateralIdx, uint256 _collateralAmount)
        external payable;
    function positionIndex() external view returns (uint256);
    function liquidate(uint256 positionId, address receiver) external;
}

/// @dev An ERC-20 that re-enters MarginModule.takeLoan from inside transferFrom.
///
/// MarginModule._receiveAsset() pulls a caller-chosen collateral / reward asset with transferFrom, which
/// hands control to the token. takeLoan used to advance `positionIndex` only as its final statement, so a
/// nested call reused the same id - overwriting positions[id] and debiting order.balance twice.
contract ReentrantCollateralToken {
    string public name = "Reentrant";
    string public symbol = "RE";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public mm;
    uint256 public orderId;
    uint256 public loanAmount;
    uint256 public collateralAmount;
    bool public armed;

    uint256 public innerPositionIndexBefore;
    bool public reentered;
    bool public innerSucceeded;
    string public innerError;

    // Liquidation-reward reentry: _liquidate pays the reward with _sendAsset -> transfer(), so a
    // malicious reward asset regains control there. Before the fix, position.open was still true and
    // subjectToLiquidation still returned true, so the reward could be collected repeatedly.
    uint256 public liqPositionId;
    address public liqReceiver;
    bool public armedLiquidate;
    uint256 public rewardTransfers;   // how many times the reward left the module

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(address _mm, uint256 _orderId, uint256 _loanAmount, uint256 _collateralAmount) external {
        mm = _mm;
        orderId = _orderId;
        loanAmount = _loanAmount;
        collateralAmount = _collateralAmount;
        armed = true;
        reentered = false;
        innerSucceeded = false;
        innerError = "";
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @dev Two liquidate() calls in a single transaction, so both land in the same block. Used to
    /// exercise the "Single block liquidations are not allowed" guard, which cannot be reached from a
    /// test that sends two transactions because hardhat auto-mines a new block (and timestamp) per tx.
    function liquidateTwice(address _mm, uint256 positionId, address receiver) external {
        IMarginModuleTakeLoan(_mm).liquidate(positionId, receiver);
        IMarginModuleTakeLoan(_mm).liquidate(positionId, receiver);
    }

    function armLiquidate(address _mm, uint256 _positionId, address _receiver) external {
        mm = _mm;
        liqPositionId = _positionId;
        liqReceiver = _receiver;
        armedLiquidate = true;
        reentered = false;
        innerSucceeded = false;
        innerError = "";
        rewardTransfers = 0;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);

        // The module paying out (msg.sender == module) is the reward transfer we care about.
        if (armedLiquidate && msg.sender == mm) {
            rewardTransfers++;
            if (!reentered) {
                reentered = true;
                try IMarginModuleTakeLoan(mm).liquidate(liqPositionId, liqReceiver) {
                    innerSucceeded = true;
                } catch Error(string memory reason) {
                    innerError = reason;
                } catch {
                    innerError = "unknown";
                }
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != uint256(-1)) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);

        if (armed && !reentered) {
            reentered = true;
            innerPositionIndexBefore = IMarginModuleTakeLoan(mm).positionIndex();
            try IMarginModuleTakeLoan(mm).takeLoan(orderId, loanAmount, 0, collateralAmount) {
                innerSucceeded = true;
            } catch Error(string memory reason) {
                innerError = reason;
            } catch {
                innerError = "unknown";
            }
        }
        return true;
    }
}
