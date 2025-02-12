import {
  Address,
  applyParamsToScript,
  Data,
  Datum,
  fromText,
  fromUnit,
  Lovelace,
  Lucid,
  MintingPolicy,
  OutRef,
  PolicyId,
  ScriptHash,
  SpendingValidator,
  toLabel,
  toUnit,
  Tx,
  TxHash,
  Unit,
  UTxO,
} from "../../deps.ts";
import scripts from "./ghc/scripts.json" assert { type: "json" };
import {
  fromAddress,
  fromAssets,
  sortDesc,
  toAddress,
  toAssets,
} from "../../common/utils.ts";
import * as D from "../../common/contract.types.ts";
import { ContractConfig, RoyaltyRecipient } from "./types.ts";

export class Contract {
  lucid: Lucid;
  tradeValidator: SpendingValidator;
  tradeHash: ScriptHash;
  tradeAddress: Address;
  mintPolicy: MintingPolicy;
  mintPolicyId: PolicyId;
  config: ContractConfig;
  fundProtocol: boolean;

  /**
   * **NOTE**: config.royaltyToken and config.fundProtocol are parameters of the marketplace contract.
   * Changing these parameters changes the plutus script and so the script hash!
   */
  constructor(
    lucid: Lucid,
    config: ContractConfig,
  ) {
    this.lucid = lucid;
    this.config = config;

    const { policyId, assetName } = fromUnit(this.config.royaltyToken);

    this.fundProtocol = this.lucid.network === "Mainnet"
      ? this.config.fundProtocol ||
          typeof this.config.fundProtocol === "undefined"
        ? true
        : false
      : false;

    const protocolKey = this.lucid.utils.getAddressDetails(
      PROTOCOL_FUND_ADDRESS,
    ).paymentCredential?.hash!;

    if (this.fundProtocol && !protocolKey) throw "Invalid protocol key!";

    this.tradeValidator = {
      type: "PlutusV2",
      script: applyParamsToScript<D.TradeParams>(
        scripts.trade,
        [
          this.fundProtocol ? protocolKey : null,
          [
            fromText(this.config.metadataKeyNames?.type || "type"),
            fromText(this.config.metadataKeyNames?.traits || "traits"),
          ],
          toLabel(100),
          [policyId, assetName || ""],
        ],
        D.TradeParams,
      ),
    };
    this.tradeHash = lucid.utils.validatorToScriptHash(this.tradeValidator);
    this.tradeAddress = lucid.utils.credentialToAddress(
      lucid.utils.scriptHashToCredential(this.tradeHash),
    );

    this.mintPolicy = lucid.utils.nativeScriptFromJson({
      type: "any",
      scripts: [
        { type: "after", slot: 0 },
        { type: "sig", keyHash: this.tradeHash },
      ],
    });
    this.mintPolicyId = lucid.utils.mintingPolicyToId(this.mintPolicy);
  }

  async buy(listingUtxos: UTxO[]): Promise<TxHash> {
    const buyOrders = (await Promise.all(
      listingUtxos.map((listingUtxo) => this._buy(listingUtxo)),
    ))
      .reduce(
        (prevTx, tx) => prevTx.compose(tx),
        this.lucid.newTx(),
      );

    const tx = await this.lucid.newTx()
      .compose(buyOrders)
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  /**
   * Accept specific bids.
   * Optionally you can accept open bids that demand any NFT from the collection for a certain lovelace amount.
   * Specify in this case the asset you are willing to sell for this price.
   */
  async sell(
    sellOptions: { bidUtxo: UTxO; assetName?: string }[],
  ): Promise<TxHash> {
    const sellOrders = (await Promise.all(
      sellOptions.map(({ bidUtxo, assetName }) =>
        this._sell(bidUtxo, assetName)
      ),
    ))
      .reduce(
        (prevTx, tx) => prevTx.compose(tx),
        this.lucid.newTx(),
      );

    const tx = await this.lucid.newTx()
      .compose(sellOrders)
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  async list(
    assetName: string,
    lovelace: Lovelace,
    privateListing?: Address | null,
  ): Promise<TxHash> {
    const ownerAddress = await this.lucid.wallet.address();
    const { stakeCredential } = this.lucid.utils
      .getAddressDetails(
        ownerAddress,
      );

    const adjustedTradeAddress = stakeCredential
      ? this.lucid.utils.credentialToAddress(
        this.lucid.utils.scriptHashToCredential(this.tradeHash),
        stakeCredential,
      )
      : this.tradeAddress;

    const tradeDatum: D.TradeDatum = {
      Listing: [
        {
          owner: fromAddress(ownerAddress),
          requestedLovelace: lovelace,
          privateListing: privateListing ? fromAddress(privateListing) : null,
        },
      ],
    };

    const tx = await this.lucid.newTx().payToContract(adjustedTradeAddress, {
      inline: Data.to<D.TradeDatum>(tradeDatum, D.TradeDatum),
    }, { [toUnit(this.config.policyId, assetName)]: 1n })
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  async changeListing(
    listingUtxo: UTxO,
    lovelace: Lovelace,
    privateListing?: Address | null,
  ): Promise<TxHash> {
    const tradeDatum = await this.lucid.datumOf<D.TradeDatum>(
      listingUtxo,
      D.TradeDatum,
    );
    if (!("Listing" in tradeDatum)) {
      throw new Error("Not a listing UTxO");
    }
    const listingDetails = tradeDatum.Listing;

    const owner: Address = toAddress(
      listingDetails[0].owner,
      this.lucid,
    );

    listingDetails[0].requestedLovelace = lovelace;
    listingDetails[0].privateListing = privateListing
      ? fromAddress(privateListing)
      : null;

    const address: Address = await this.lucid.wallet.address();

    if (owner !== address) throw new Error("You are not the owner.");

    const refScripts = await this.getDeployedScripts();

    const tx = await this.lucid.newTx()
      .collectFrom(
        [listingUtxo],
        Data.to<D.TradeAction>("Cancel", D.TradeAction),
      )
      .payToContract(listingUtxo.address, {
        inline: Data.to<D.TradeDatum>(tradeDatum, D.TradeDatum),
      }, listingUtxo.assets)
      .addSigner(owner)
      .readFrom([refScripts.trade])
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  /** Create a bid on a specific token within the collection. */
  async bid(assetName: string, lovelace: Lovelace): Promise<TxHash> {
    const ownerAddress = await this.lucid.wallet.address();
    const { stakeCredential } = this.lucid.utils.getAddressDetails(
      ownerAddress,
    );

    const adjustedTradeAddress = stakeCredential
      ? this.lucid.utils.credentialToAddress(
        this.lucid.utils.scriptHashToCredential(this.tradeHash),
        stakeCredential,
      )
      : this.tradeAddress;

    const biddingDatum: D.TradeDatum = {
      Bid: [{
        owner: fromAddress(ownerAddress),
        requestedOption: {
          SpecificValue: [
            fromAssets({ [toUnit(this.config.policyId, assetName)]: 1n }),
          ],
        },
      }],
    };

    const tx = await this.lucid.newTx()
      .mintAssets({
        [toUnit(this.mintPolicyId, fromText("Bid") + assetName)]: 1n,
      })
      .payToContract(adjustedTradeAddress, {
        inline: Data.to<D.TradeDatum>(biddingDatum, D.TradeDatum),
      }, {
        lovelace,
        [toUnit(this.mintPolicyId, fromText("Bid") + assetName)]: 1n,
      })
      .validFrom(this.lucid.utils.slotToUnixTime(1000))
      .attachMintingPolicy(this.mintPolicy)
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  /** Create a bid on any token within the collection. Optionally add constraints. */
  async bidOpen(
    lovelace: Lovelace,
    constraints?: {
      types?: string[];
      traits?: { negation?: boolean; trait: string }[];
    },
  ): Promise<TxHash> {
    const ownerAddress = await this.lucid.wallet.address();
    const { stakeCredential } = this.lucid.utils.getAddressDetails(
      ownerAddress,
    );

    const adjustedTradeAddress = stakeCredential
      ? this.lucid.utils.credentialToAddress(
        this.lucid.utils.scriptHashToCredential(this.tradeHash),
        stakeCredential,
      )
      : this.tradeAddress;

    const biddingDatum: D.TradeDatum = {
      Bid: [{
        owner: fromAddress(ownerAddress),
        requestedOption: {
          SpecificSymbolWithConstraints: [
            this.config.policyId,
            constraints?.types ? constraints.types.map(fromText) : [],
            constraints?.traits
              ? constraints.traits.map((
                { negation, trait },
              ) => [negation ? -1n : 0n, fromText(trait)])
              : [],
          ],
        },
      }],
    };

    const tx = await this.lucid.newTx()
      .mintAssets({
        [toUnit(this.mintPolicyId, fromText("OpenBid"))]: 1n,
      })
      .payToContract(adjustedTradeAddress, {
        inline: Data.to<D.TradeDatum>(biddingDatum, D.TradeDatum),
      }, {
        lovelace,
        [toUnit(this.mintPolicyId, fromText("OpenBid"))]: 1n,
      })
      .validFrom(this.lucid.utils.slotToUnixTime(1000))
      .attachMintingPolicy(this.mintPolicy)
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  async changeBid(bidUtxo: UTxO, lovelace: Lovelace): Promise<TxHash> {
    const tradeDatum = await this.lucid.datumOf<D.TradeDatum>(
      bidUtxo,
      D.TradeDatum,
    );
    if (!("Bid" in tradeDatum)) {
      throw new Error("Not a bidding UTxO");
    }

    const owner: Address = toAddress(tradeDatum.Bid[0].owner, this.lucid);

    const address: Address = await this.lucid.wallet.address();

    if (owner !== address) throw new Error("You are not the owner.");

    const refScripts = await this.getDeployedScripts();

    const tx = await this.lucid.newTx().collectFrom(
      [bidUtxo],
      Data.to<D.TradeAction>("Cancel", D.TradeAction),
    ).payToContract(bidUtxo.address, {
      inline: bidUtxo.datum!,
    }, { ...bidUtxo.assets, lovelace })
      .addSigner(owner)
      .readFrom([refScripts.trade])
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  async cancelListing(listingUtxo: UTxO): Promise<TxHash> {
    const tx = await this.lucid.newTx().compose(
      await this._cancelListing(listingUtxo),
    )
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  async cancelBid(bidUtxo: UTxO): Promise<TxHash> {
    const tx = await this.lucid.newTx().compose(await this._cancelBid(bidUtxo))
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  async cancelListingAndSell(
    listingUtxo: UTxO,
    bidUtxo: UTxO,
    assetName?: string,
  ): Promise<TxHash> {
    const tx = await this.lucid.newTx()
      .compose(await this._cancelListing(listingUtxo))
      .compose(await this._sell(bidUtxo, assetName))
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  async cancelBidAndBuy(
    bidUtxo: UTxO,
    listingUtxo: UTxO,
  ): Promise<TxHash> {
    const tx = await this.lucid.newTx()
      .compose(await this._cancelBid(bidUtxo))
      .compose(await this._buy(listingUtxo))
      .complete();

    const txSigned = await tx.sign().complete();
    return txSigned.submit();
  }

  /** Get a specific listing or bid. */
  async getListingOrBid(outRef: OutRef): Promise<UTxO | null> {
    const [utxo] = await this.lucid.utxosByOutRef([outRef]);
    return utxo || null;
  }

  /** Return the current listings for a specific asset sorted in descending order by price. */
  async getListings(assetName: string): Promise<UTxO[]> {
    return (await this.lucid.utxosAtWithUnit(
      this.tradeAddress,
      toUnit(
        this.config.policyId,
        assetName,
      ),
    )).filter((utxo) => Object.keys(utxo.assets).length === 2).sort(sortDesc);
  }

  /**
   * Return the current bids for a specific token sorted in descending order by price.
   * Or return the open bids on any token within the collection (use 'open' as arg instead of an asset name).
   */
  async getBids(assetName: "Open" | string): Promise<UTxO[]> {
    return (await this.lucid.utxosAtWithUnit(
      this.tradeAddress,
      toUnit(
        this.mintPolicyId,
        assetName === "Open"
          ? fromText("OpenBid")
          : fromText("Bid") + assetName,
      ),
    )).filter((utxo) => Object.keys(utxo.assets).length === 2).sort(sortDesc);
  }

  /**
   * Create a royalty token and lock it in a script controlled by the specified owner.
   * The output the royalty token is in holds the royalty info (fees, recipients) in the datum.\
   * minAda is the threshold that decides to pay fee as percentage or fixed.
   */
  static async createRoyalty(
    lucid: Lucid,
    royaltyRecipients: RoyaltyRecipient[],
    owner: Address,
    minAda: Lovelace = 1000000n,
  ): Promise<{ txHash: TxHash; royaltyToken: Unit }> {
    const ownerKeyHash = lucid.utils.getAddressDetails(owner).paymentCredential
      ?.hash!;

    const ownersScript = lucid.utils.nativeScriptFromJson({
      type: "sig",
      keyHash: ownerKeyHash,
    });
    const ownersAddress = lucid.utils.validatorToAddress(ownersScript);

    const [utxo] = await lucid.wallet.getUtxos();

    const royaltyMintingPolicy: MintingPolicy = {
      type: "PlutusV2",
      script: applyParamsToScript<[D.OutRef]>(
        scripts.oneShot,
        [
          {
            txHash: { hash: utxo.txHash },
            outputIndex: BigInt(utxo.outputIndex),
          },
        ],
        Data.Tuple([D.OutRef]),
      ),
    };

    const royaltyPolicyId = lucid.utils.mintingPolicyToId(
      royaltyMintingPolicy,
    );

    const royaltyUnit = toUnit(royaltyPolicyId, fromText("Royalty"), 500);

    const royaltyInfo: D.RoyaltyInfo = {
      recipients: royaltyRecipients.map((recipient) => ({
        address: fromAddress(recipient.address),
        fee: BigInt(Math.floor(1 / (recipient.fee / 10))),
        fixedFee: recipient.fixedFee,
      })),
      minAda,
    };

    const tx = await lucid.newTx()
      .collectFrom([utxo], Data.void())
      .mintAssets({
        [royaltyUnit]: 1n,
      }, Data.void()).payToAddressWithData(
        ownersAddress,
        { inline: Data.to<D.RoyaltyInfo>(royaltyInfo, D.RoyaltyInfo) },
        { [royaltyUnit]: 1n },
      )
      .validFrom(lucid.utils.slotToUnixTime(1000))
      .attachMintingPolicy(royaltyMintingPolicy)
      .complete();

    const txSigned = await tx.sign().complete();

    console.log("\n💰 Royalty Token:", royaltyUnit);
    console.log(
      "You can now paste the Royalty Token into the Contract config.\n",
    );

    return { txHash: await txSigned.submit(), royaltyToken: royaltyUnit };
  }

  /** Deploy necessary scripts to reduce tx costs heavily. */
  async deployScripts(): Promise<TxHash> {
    const deployScript = this.lucid.utils.nativeScriptFromJson({
      type: "sig",
      keyHash: this.lucid.utils.getAddressDetails(this.config.owner)
        .paymentCredential
        ?.hash!,
    });

    const ownerAddress = this.lucid.utils.validatorToAddress(deployScript);

    const tx = await this.lucid.newTx()
      .payToAddressWithData(ownerAddress, {
        scriptRef: this.tradeValidator,
      }, {}).complete();

    const txSigned = await tx.sign().complete();

    console.log("\n⛓ Deploy Tx Hash:", txSigned.toHash());
    console.log(
      "You can now paste the Tx Hash into the Contract config.\n",
    );

    return txSigned.submit();
  }

  /** Return the datum of the UTxO the royalty token is locked in. */
  async getRoyalty(): Promise<{ utxo: UTxO; royaltyInfo: D.RoyaltyInfo }> {
    const utxo = await this.lucid.utxoByUnit(
      this.config.royaltyToken,
    );
    if (!utxo) throw new Error("Royalty info not found.");

    return {
      utxo,
      royaltyInfo: await this.lucid.datumOf<D.RoyaltyInfo>(utxo, D.RoyaltyInfo),
    };
  }

  async getDeployedScripts(): Promise<{ trade: UTxO }> {
    if (!this.config.deployTxHash) throw new Error("Scripts are not deployed.");
    const [trade] = await this.lucid.utxosByOutRef([{
      txHash: this.config.deployTxHash,
      outputIndex: 0,
    }]);
    return { trade };
  }

  getContractHashes(): {
    scriptHash: ScriptHash;
    nftPolicyId: PolicyId;
    bidPolicyId: PolicyId;
  } {
    return {
      scriptHash: this.tradeHash,
      nftPolicyId: this.config.policyId,
      bidPolicyId: this.mintPolicyId,
    };
  }

  /**
   * Update royalty info like fees and recipients.\
   * minAda is the threshold that decides to pay fee as percentage or fixed.
   */
  async updateRoyalty(
    royaltyRecipients: RoyaltyRecipient[],
    minAda: Lovelace = 1000000n,
  ): Promise<TxHash> {
    const ownersScript = this.lucid.utils.nativeScriptFromJson({
      type: "sig",
      keyHash: this.lucid.utils.getAddressDetails(this.config.owner)
        .paymentCredential?.hash!,
    });
    const ownerAddress = this.lucid.utils.validatorToAddress(ownersScript);

    const utxos = await this.lucid.utxosAt(ownerAddress);
    const royaltyUtxo = utxos.find((utxo) =>
      utxo.assets[this.config.royaltyToken]
    );

    if (!royaltyUtxo) throw new Error("NoUTxOError");

    const royaltyInfo: D.RoyaltyInfo = {
      recipients: royaltyRecipients.map((recipient) => ({
        address: fromAddress(recipient.address),
        fee: BigInt(Math.floor(1 / (recipient.fee / 10))),
        fixedFee: recipient.fixedFee,
      })),
      minAda,
    };

    const tx = await this.lucid.newTx()
      .collectFrom([royaltyUtxo])
      .payToAddressWithData(
        ownerAddress,
        { inline: Data.to<D.RoyaltyInfo>(royaltyInfo, D.RoyaltyInfo) },
        royaltyUtxo.assets,
      )
      .attachSpendingValidator(ownersScript)
      .complete();

    const txSigned = await tx.sign().complete();

    return txSigned.submit();
  }

  private async _cancelListing(listingUtxo: UTxO): Promise<Tx> {
    const tradeDatum = await this.lucid.datumOf<D.TradeDatum>(
      listingUtxo,
      D.TradeDatum,
    );
    if (!("Listing" in tradeDatum)) {
      throw new Error("Not a listing UTxO");
    }
    const owner: Address = toAddress(tradeDatum.Listing[0].owner, this.lucid);

    const address: Address = await this.lucid.wallet.address();

    if (owner !== address) throw new Error("You are not the owner.");

    const refScripts = await this.getDeployedScripts();

    return this.lucid.newTx().collectFrom(
      [listingUtxo],
      Data.to<D.TradeAction>("Cancel", D.TradeAction),
    )
      .addSigner(owner)
      .readFrom([refScripts.trade]);
  }

  private async _sell(
    bidUtxo: UTxO,
    assetName?: string,
  ): Promise<Tx> {
    const tradeDatum = await this.lucid.datumOf<D.TradeDatum>(
      bidUtxo,
      D.TradeDatum,
    );
    if (!("Bid" in tradeDatum)) {
      throw new Error("Not a bidding UTxO");
    }

    const bidDetails = tradeDatum.Bid[0];

    const { lovelace } = bidUtxo.assets;
    const bidToken = Object.keys(bidUtxo.assets).find((unit) =>
      unit.startsWith(this.mintPolicyId)
    );
    if (!bidToken) throw new Error("No bid token found.");

    const owner: Address = toAddress(bidDetails.owner, this.lucid);

    const { requestedAssets, refNFT } = (() => {
      if ("SpecificValue" in bidDetails.requestedOption) {
        return {
          requestedAssets: toAssets(
            bidDetails.requestedOption.SpecificValue[0],
          ),
          refNFT: null,
        };
      } else if (
        "SpecificSymbolWithConstraints" in bidDetails.requestedOption &&
        assetName
      ) {
        const policyId: PolicyId =
          bidDetails.requestedOption.SpecificSymbolWithConstraints[0];
        const refNFT = toUnit(
          policyId,
          fromUnit(toUnit(policyId, assetName)).name,
          100,
        );
        const types =
          bidDetails.requestedOption.SpecificSymbolWithConstraints[1];
        const traits =
          bidDetails.requestedOption.SpecificSymbolWithConstraints[2];

        return {
          requestedAssets: {
            [toUnit(policyId, assetName)]: 1n,
          },
          refNFT: types.length > 0 || traits.length > 0 ? refNFT : null,
        };
      }
      throw new Error("No variant matched.");
    })();

    const paymentDatum = Data.to<D.PaymentDatum>({
      outRef: {
        txHash: { hash: bidUtxo.txHash },
        outputIndex: BigInt(bidUtxo.outputIndex),
      },
    }, D.PaymentDatum);

    const refScripts = await this.getDeployedScripts();

    return this.lucid.newTx().collectFrom(
      [bidUtxo],
      Data.to<D.TradeAction>("Sell", D.TradeAction),
    )
      .compose(
        refNFT
          ? await (async () => {
            const refUtxo = await this.lucid.utxoByUnit(refNFT!);
            if (!refUtxo) throw new Error("This NFT doesn't support CIP-0068");
            return this.lucid.newTx().readFrom([refUtxo]);
          })()
          : null,
      )
      .compose(
        (await this._payFee(
          lovelace,
          paymentDatum,
        )).tx,
      ).payToAddressWithData(owner, {
        inline: paymentDatum,
      }, requestedAssets)
      .mintAssets({ [bidToken]: -1n })
      .compose(
        this.fundProtocol
          ? this.lucid.newTx().payToAddress(PROTOCOL_FUND_ADDRESS, {})
          : null,
      )
      .validFrom(this.lucid.utils.slotToUnixTime(1000))
      .readFrom([refScripts.trade])
      .attachMintingPolicy(this.mintPolicy);
  }

  private async _cancelBid(bidUtxo: UTxO): Promise<Tx> {
    const tradeDatum = await this.lucid.datumOf<D.TradeDatum>(
      bidUtxo,
      D.TradeDatum,
    );
    if (!("Bid" in tradeDatum)) {
      throw new Error("Not a bidding UTxO");
    }
    const owner: Address = toAddress(tradeDatum.Bid[0].owner, this.lucid);

    const address: Address = await this.lucid.wallet.address();

    if (owner !== address) throw new Error("You are not the owner.");

    const [bidToken] = Object.keys(bidUtxo.assets).filter((unit) =>
      unit !== "lovelace"
    );

    const refScripts = await this.getDeployedScripts();

    return this.lucid.newTx().collectFrom(
      [bidUtxo],
      Data.to<D.TradeAction>("Cancel", D.TradeAction),
    )
      .mintAssets({ [bidToken]: -1n })
      .validFrom(this.lucid.utils.slotToUnixTime(1000))
      .addSigner(owner)
      .readFrom([refScripts.trade])
      .attachMintingPolicy(this.mintPolicy);
  }

  private async _buy(listingUtxo: UTxO): Promise<Tx> {
    const tradeDatum = await this.lucid.datumOf<D.TradeDatum>(
      listingUtxo,
      D.TradeDatum,
    );
    if (!("Listing" in tradeDatum)) {
      throw new Error("Not a listing UTxO");
    }

    const owner: Address = toAddress(tradeDatum.Listing[0].owner, this.lucid);
    const requestedLovelace: Lovelace = tradeDatum.Listing[0].requestedLovelace;
    const privateListing = tradeDatum.Listing[0].privateListing;

    const paymentDatum = Data.to<D.PaymentDatum>({
      outRef: {
        txHash: { hash: listingUtxo.txHash },
        outputIndex: BigInt(listingUtxo.outputIndex),
      },
    }, D.PaymentDatum);

    const refScripts = await this.getDeployedScripts();

    return this.lucid.newTx().collectFrom(
      [listingUtxo],
      Data.to<D.TradeAction>("Buy", D.TradeAction),
    )
      .compose(
        await (async () => {
          const { tx, remainingLovelace } = await this._payFee(
            requestedLovelace,
            paymentDatum,
          );
          return tx.payToAddressWithData(owner, { inline: paymentDatum }, {
            lovelace: remainingLovelace,
          });
        })(),
      )
      .compose(
        privateListing
          ? this.lucid.newTx().addSigner(
            toAddress(privateListing!, this.lucid),
          )
          : null,
      )
      .compose(
        this.fundProtocol
          ? this.lucid.newTx().payToAddress(PROTOCOL_FUND_ADDRESS, {})
          : null,
      )
      .readFrom([refScripts.trade]);
  }

  private async _payFee(
    lovelace: Lovelace,
    paymentDatum: Datum,
  ): Promise<{ tx: Tx; remainingLovelace: Lovelace }> {
    const tx = this.lucid.newTx();

    const { utxo, royaltyInfo } = await this.getRoyalty();
    let remainingLovelace = lovelace;

    const recipients = royaltyInfo.recipients;
    const minAda = royaltyInfo.minAda;

    for (const recipient of recipients) {
      const address: Address = toAddress(
        recipient.address,
        this.lucid,
      );
      const fee = recipient.fee;
      const fixedFee = recipient.fixedFee;

      const feeToPay = (lovelace * 10n) / fee;
      const adjustedFee = feeToPay < minAda ? fixedFee : feeToPay;

      remainingLovelace -= adjustedFee;
      if (remainingLovelace <= 0n) {
        throw new Error("No lovelace left for recipient.");
      }

      tx.payToAddressWithData(address, { inline: paymentDatum }, {
        lovelace: adjustedFee,
      });
    }

    tx.readFrom([utxo]);

    return { tx, remainingLovelace };
  }
}

const PROTOCOL_FUND_ADDRESS =
  "addr1vxuj4yyqlz0k9er5geeepx0awh2t6kkes0nyp429hsttt3qrnucsx";
