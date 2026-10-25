package main

import (
	"fmt"
	"math"
	"strconv"

	"github.com/gnolang/gno/gnovm/stdlibs/chain"
	abci "github.com/gnolang/gno/tm2/pkg/bft/abci/types"
	"github.com/gnolang/gno/tm2/pkg/std"
)

func addCost(a, b int64) (int64, error) {
	if a < 0 || b < 0 || a > math.MaxInt64-b {
		return 0, fmt.Errorf("invalid or overflowing native cost")
	}
	return a + b, nil
}

// Refunds never offset the deposit ceiling: both can occur in the same call.
func storageCosts(events []abci.Event) (deposit, refund int64, err error) {
	coinAmount := func(c std.Coin) (int64, error) {
		if c.Denom != "ugnot" || c.Amount < 0 {
			return 0, fmt.Errorf("invalid storage cost coin")
		}
		return c.Amount, nil
	}
	for _, event := range events {
		var c std.Coin
		var unlock, withheld bool
		switch e := event.(type) {
		case chain.StorageDepositEvent:
			c = e.FeeDelta
		case chain.StorageUnlockEvent:
			c = e.FeeRefund
			unlock = true
			withheld = e.RefundWithheld
		default:
			continue
		}
		amount, e := coinAmount(c)
		if e != nil {
			return 0, 0, e
		}
		if unlock {
			if !withheld {
				refund, err = addCost(refund, amount)
			}
		} else {
			deposit, err = addCost(deposit, amount)
		}
		if err != nil {
			return 0, 0, err
		}
	}
	return deposit, refund, nil
}

func applyExecutionBounds(c *config, body callReq) error {
	fee, e1 := strconv.ParseInt(body.MaxFeeUgnot, 10, 64)
	storage, e2 := strconv.ParseInt(body.MaxStorageDepositUgnot, 10, 64)
	if e1 != nil || e2 != nil || fee <= 0 || storage <= 0 || body.MaxGasWanted <= 0 || storage >= fee {
		return fmt.Errorf("positive gas, combined fee and storage limits are required; storage must be below the combined fee limit")
	}
	c.maxGasWanted, c.maxFeeUgnot, c.maxStorageDepositUgnot = body.MaxGasWanted, fee, storage
	return nil
}
