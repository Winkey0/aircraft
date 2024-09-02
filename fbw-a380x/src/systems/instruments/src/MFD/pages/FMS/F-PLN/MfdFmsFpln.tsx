﻿import {
  ArraySubject,
  ClockEvents,
  ComponentProps,
  DisplayComponent,
  FSComponent,
  MappedSubject,
  NodeReference,
  Subject,
  Subscribable,
  Subscription,
  VNode,
} from '@microsoft/msfs-sdk';

import './MfdFmsFpln.scss';
import { AbstractMfdPageProps } from 'instruments/src/MFD/MFD';
import { Footer } from 'instruments/src/MFD/pages/common/Footer';

import { Button, ButtonMenuItem } from 'instruments/src/MFD/pages/common/Button';
import { IconButton } from 'instruments/src/MFD/pages/common/IconButton';
import { ContextMenu, ContextMenuElement } from 'instruments/src/MFD/pages/common/ContextMenu';
import { FplnRevisionsMenuType, getRevisionsMenu } from 'instruments/src/MFD/pages/FMS/F-PLN/FplnRevisionsMenu';
import { DestinationWindow } from 'instruments/src/MFD/pages/FMS/F-PLN/DestinationWindow';
import { InsertNextWptFromWindow, NextWptInfo } from 'instruments/src/MFD/pages/FMS/F-PLN/InsertNextWptFrom';
import { FmsPage } from 'instruments/src/MFD/pages/common/FmsPage';
import { FlightPlanLeg } from '@fmgc/flightplanning/legs/FlightPlanLeg';
import { SegmentClass } from '@fmgc/flightplanning/segments/SegmentClass';
import { WindVector } from '@fmgc/guidance/vnav/wind';
import { PseudoWaypoint } from '@fmgc/guidance/PseudoWaypoint';
import { Coordinates, bearingTo } from 'msfs-geo';
import { FmgcFlightPhase } from '@shared/flightphase';
import { Units, LegType, TurnDirection, AltitudeDescriptor } from '@flybywiresim/fbw-sdk';
import { MfdFmsFplnVertRev } from 'instruments/src/MFD/pages/FMS/F-PLN/MfdFmsFplnVertRev';
import { AltitudeConstraint, SpeedConstraint } from '@fmgc/flightplanning/data/constraint';

interface MfdFmsFplnProps extends AbstractMfdPageProps {}

export interface DerivedFplnLegData {
  trackFromLastWpt: number | null;
  distanceFromLastWpt: number | null;
  windPrediction: WindVector | null;
}

export class MfdFmsFpln extends FmsPage<MfdFmsFplnProps> {
  private lineColor = Subject.create<FplnLineColor>(FplnLineColor.Active);

  private spdAltEfobWindRef = FSComponent.createRef<HTMLDivElement>();

  private displayEfobAndWind = Subject.create<boolean>(false);

  private trueTrackEnabled = Subject.create<boolean>(false);

  private efobAndWindButtonDynamicContent = Subject.create<VNode>(<span />);

  private efobAndWindButtonMenuItems = Subject.create<ButtonMenuItem[]>([{ label: '', action: () => {} }]);

  private lineData: FplnLineDisplayData[] = [];

  private renderedLineData = [
    Subject.create<FplnLineDisplayData | null>(null),
    Subject.create<FplnLineDisplayData | null>(null),
    Subject.create<FplnLineDisplayData | null>(null),
    Subject.create<FplnLineDisplayData | null>(null),
    Subject.create<FplnLineDisplayData | null>(null),
    Subject.create<FplnLineDisplayData | null>(null),
    Subject.create<FplnLineDisplayData | null>(null),
    Subject.create<FplnLineDisplayData | null>(null),
    Subject.create<FplnLineDisplayData | null>(null),
  ];

  private lastRenderedActiveLegIndex: number | null = null;

  private lastRenderedFpVersion: number | null = null;

  private derivedFplnLegData: DerivedFplnLegData[] = [];

  private linesDivRef = FSComponent.createRef<HTMLDivElement>();

  private tmpyLineRef = FSComponent.createRef<HTMLDivElement>();

  private destButtonLabel = Subject.create<string>('');

  private destButtonDisabled = Subject.create<boolean>(true);

  private destTimeLabel = Subject.create<string>('--:--');

  private destEfob = Subject.create<string>('--.-');

  private destDistanceLabel = Subject.create<string>('---');

  private displayFplnFromLineIndex = Subject.create<number>(0);

  private lastRenderedDisplayLineIndex: number = -1;

  private disabledScrollDown = Subject.create(true);

  private disabledScrollUp = Subject.create(false);

  private revisionsMenuRef = FSComponent.createRef<ContextMenu>();

  private revisionsMenuValues = Subject.create<ContextMenuElement[]>([]);

  private revisionsMenuOpened = Subject.create<boolean>(false);

  private newDestWindowOpened = Subject.create<boolean>(false);

  private insertNextWptWindowOpened = Subject.create<boolean>(false);

  private nextWptAvailableWaypoints = ArraySubject.create<NextWptInfo>([]);

  private renderedFplnLines: NodeReference<FplnLegLine>[] = [];

  protected onNewData(): void {
    if (!this.loadedFlightPlan) {
      return;
    }

    console.time('F-PLN:onNewData');

    // update(...) is the most costly function. First performance improvement: Don't render everything completely new every time, just update with refs
    // Delete and re-render FPLN lines only if:
    // a) activeLegIndex changes
    // b) flight plan version was increased
    // c) list was scrolled up or down
    const activeLegIndexChanged = this.lastRenderedActiveLegIndex !== this.loadedFlightPlan.activeLegIndex;
    const fpVersionIncreased = this.lastRenderedFpVersion !== this.loadedFlightPlan.version;
    const listWasScrolled = this.lastRenderedDisplayLineIndex !== this.displayFplnFromLineIndex.get();
    const onlyUpdatePredictions = !(activeLegIndexChanged || fpVersionIncreased || listWasScrolled);

    // If we somehow ended up before the FROM waypoint, also update the internal state. Triggers a call of this function, so we can stop this call.
    if (this.displayFplnFromLineIndex.get() < this.loadedFlightPlan.activeLegIndex - 1) {
      this.displayFplnFromLineIndex.set(this.loadedFlightPlan.activeLegIndex - 1);
      return;
    }

    this.update(this.displayFplnFromLineIndex.get(), onlyUpdatePredictions);

    this.lastRenderedActiveLegIndex = this.loadedFlightPlan.activeLegIndex ?? null;
    this.lastRenderedFpVersion = this.loadedFlightPlan.version ?? null;
    this.lastRenderedDisplayLineIndex = this.displayFplnFromLineIndex.get();

    if (this.loadedFlightPlan.destinationAirport) {
      this.destButtonDisabled.set(false);
      if (this.loadedFlightPlan.destinationRunway) {
        this.destButtonLabel.set(
          `${this.loadedFlightPlan.destinationRunway.airportIdent}${this.loadedFlightPlan.destinationRunway.ident.substring(4)}`,
        );
      } else {
        this.destButtonLabel.set(this.loadedFlightPlan.destinationAirport.ident);
      }
    } else {
      this.destButtonDisabled.set(true);
      this.destButtonLabel.set('------');
    }

    const destPred = this.props.fmcService?.master?.guidanceController?.vnavDriver?.getDestinationPrediction();
    if (destPred && this.props.fmcService.master) {
      const utcTime = SimVar.GetGlobalVarValue('ZULU TIME', 'seconds');
      const eta = new Date((utcTime + destPred.secondsFromPresent) * 1000);
      this.destTimeLabel.set(
        `${eta.getHours().toString().padStart(2, '0')}:${eta.getMinutes().toString().padStart(2, '0')}`,
      );
      this.destEfob.set(
        this.props.fmcService.master.fmgc.getDestEFOB(true) > 0
          ? this.props.fmcService.master.fmgc.getDestEFOB(true).toFixed(1)
          : '--.-',
      );
      this.destDistanceLabel.set(
        Number.isFinite(destPred.distanceFromAircraft) ? destPred.distanceFromAircraft.toFixed(0) : '---',
      );
    }
    this.checkScrollButtons();
    console.timeEnd('F-PLN:onNewData');
  }

  private update(startAtIndex: number, onlyUpdatePredictions = true): void {
    if (!this.loadedFlightPlan) {
      return;
    }

    const shouldOnlyUpdatePredictions = this.lineData !== undefined && onlyUpdatePredictions;

    // Make sure that you can't scroll higher than the FROM wpt
    const startAtIndexChecked =
      startAtIndex < (this.loadedFlightPlan.activeLegIndex ?? 1) - 1
        ? (this.loadedFlightPlan.activeLegIndex ?? 1) - 1
        : startAtIndex;

    // Compute rest of required attributes
    this.derivedFplnLegData = [];
    let lastDistanceFromStart: number = 0;
    let lastLegLatLong: Coordinates = { lat: 0, long: 0 };
    // Construct leg data for all legs
    const jointFlightPlan = this.loadedFlightPlan.allLegs.concat(this.loadedFlightPlan.alternateFlightPlan.allLegs);

    if (!jointFlightPlan) {
      return;
    }

    jointFlightPlan.forEach((el, index) => {
      const newEl: DerivedFplnLegData = { distanceFromLastWpt: null, trackFromLastWpt: null, windPrediction: null };

      if (
        index === this.loadedFlightPlan?.allLegs.length ||
        index === this.loadedFlightPlan?.firstMissedApproachLegIndex
      ) {
        // Reset distance accumulation for ALTN flight plan and for missed apch
        lastDistanceFromStart = 0;
      }

      if (
        el instanceof FlightPlanLeg &&
        index < (this.loadedFlightPlan?.legCount ?? 0) + (this.loadedFlightPlan?.alternateFlightPlan.legCount ?? 0)
      ) {
        if (index === 0 || el.calculated === undefined) {
          newEl.distanceFromLastWpt = null;
          newEl.trackFromLastWpt = null;
          newEl.windPrediction = WindVector.default();
        } else {
          newEl.distanceFromLastWpt = el.calculated.cumulativeDistanceWithTransitions - lastDistanceFromStart;
          newEl.trackFromLastWpt = el.definition.waypoint
            ? bearingTo(lastLegLatLong, el.definition.waypoint.location)
            : null;
          newEl.windPrediction = WindVector.default();
        }

        if (el.calculated !== undefined) {
          lastDistanceFromStart = el?.calculated?.cumulativeDistanceWithTransitions ?? lastDistanceFromStart;
          lastLegLatLong = el.definition.waypoint?.location ?? lastLegLatLong;
        }
      } else {
        newEl.distanceFromLastWpt = null;
        newEl.trackFromLastWpt = null;
        newEl.windPrediction = WindVector.default();
      }

      this.derivedFplnLegData.push(newEl);
    });

    this.lineData = [];

    // Prepare sequencing of pseudo waypoints
    const pseudoWptMap = new Map<number, PseudoWaypoint>();
    // Insert pseudo waypoints from guidance controller
    this.props.fmcService?.master?.guidanceController?.pseudoWaypoints?.pseudoWaypoints?.forEach((wpt) =>
      pseudoWptMap.set(wpt.alongLegIndex, wpt),
    );

    lastDistanceFromStart = 0;
    const fmgcFlightPhase = this.props.fmcService.master?.fmgc.getFlightPhase() ?? FmgcFlightPhase.Preflight;

    const predictionTimestamp = (seconds: number) => {
      if (seconds === undefined) {
        return 0;
      }

      if (fmgcFlightPhase >= FmgcFlightPhase.Takeoff) {
        const eta = (SimVar.GetGlobalVarValue('ZULU TIME', 'seconds') + seconds) * 1000;
        return eta;
      }
      if (this.props.fmcService.master?.fmgc.data.estimatedTakeoffTime.get() !== undefined) {
        const eta = ((this.props.fmcService.master.fmgc.data.estimatedTakeoffTime.get() ?? 0) + seconds) * 1000;
        return eta;
      }
      return seconds * 1000;
    };

    for (let i = 0; i < jointFlightPlan.length; i++) {
      const leg = jointFlightPlan[i];
      const isAltn = i >= (this.loadedFlightPlan.allLegs.length ?? 0);
      let reduceDistanceBy = 0;

      const pwp = pseudoWptMap.get(i);
      if (pwp && pwp.displayedOnMcdu) {
        reduceDistanceBy = (pwp.flightPlanInfo?.distanceFromStart ?? 0) - lastDistanceFromStart;
        const data: FplnLineWaypointDisplayData = {
          type: FplnLineType.Waypoint,
          originalLegIndex: null,
          isPseudoWaypoint: true,
          isAltnWaypoint: isAltn,
          isMissedAppchWaypoint: isAltn
            ? i >= (this.loadedFlightPlan.alternateFlightPlan.firstMissedApproachLegIndex ?? Infinity)
            : i >= (this.loadedFlightPlan?.firstMissedApproachLegIndex ?? Infinity),
          ident: pwp.mcduIdent ?? pwp.ident,
          overfly: false,
          annotation: pwp.mcduHeader ?? '',
          etaOrSecondsFromPresent: predictionTimestamp(pwp.flightPlanInfo?.secondsFromPresent ?? 0),
          transitionAltitude: leg instanceof FlightPlanLeg ? leg.definition.transitionAltitude ?? 18000 : 18000,
          altitudePrediction: pwp.flightPlanInfo?.altitude ?? null,
          hasAltitudeConstraint: false, // TODO
          altitudeConstraint: null, // TODO
          altitudeConstraintIsRespected: true,
          speedPrediction: pwp.flightPlanInfo?.speed ?? null,
          hasSpeedConstraint: (pwp.mcduIdent ?? pwp.ident) === '(SPDLIM)',
          speedConstraint: null, // TODO
          speedConstraintIsRespected: true,
          efobPrediction:
            Units.poundToKilogram(
              this.props.fmcService.master?.guidanceController.vnavDriver.mcduProfile?.waypointPredictions?.get(i)
                ?.estimatedFuelOnBoard ?? 0,
            ) / 1000.0,
          windPrediction: this.derivedFplnLegData[i].windPrediction,
          trackFromLastWpt: this.derivedFplnLegData[i].trackFromLastWpt,
          distFromLastWpt: reduceDistanceBy,
          fpa: null,
        };
        lastDistanceFromStart = pwp.flightPlanInfo?.distanceFromStart ?? 0;
        this.lineData.push(data);
      }

      if (leg instanceof FlightPlanLeg) {
        const transAlt = this.loadedFlightPlan.performanceData.transitionAltitude ?? 18_000;
        const transLevelAsAlt = Number.isFinite(this.loadedFlightPlan.performanceData.transitionLevel)
          ? (this.loadedFlightPlan.performanceData.transitionLevel ?? 18_000) * 100
          : 18_000;
        const useTransLevel =
          i >=
          this.loadedFlightPlan.originSegment.legCount +
            this.loadedFlightPlan.enrouteSegment.legCount +
            this.loadedFlightPlan.departureSegment.legCount +
            this.loadedFlightPlan.departureRunwayTransitionSegment.legCount +
            this.loadedFlightPlan.departureEnrouteTransitionSegment.legCount;

        if (leg.type === LegType.HM) {
          // Insert special HM line, TODO
          const holdData: FplnLineHoldDisplayData = {
            type: FplnLineType.Hold,
            originalLegIndex: i,
            isPseudoWaypoint: false,
            isAltnWaypoint: isAltn,
            isMissedAppchWaypoint: isAltn
              ? i >= this.loadedFlightPlan.alternateFlightPlan.firstMissedApproachLegIndex
              : i >= this.loadedFlightPlan.firstMissedApproachLegIndex,
            ident: leg.definition.turnDirection === TurnDirection.Left ? 'HOLD L' : 'HOLD R',
            distFromLastWpt: leg.definition.length ?? null,
            holdSpeed: 123,
          };
          this.lineData.push(holdData);
        }

        const annotation = leg.type === LegType.HF || leg.type === LegType.HA ? 'HOLD L' : leg.annotation;

        const pred =
          this.props.fmcService?.master?.guidanceController?.vnavDriver?.mcduProfile?.waypointPredictions?.get(i);

        const data: FplnLineWaypointDisplayData = {
          type: FplnLineType.Waypoint,
          originalLegIndex: isAltn ? i - this.loadedFlightPlan.legCount : i,
          isPseudoWaypoint: false,
          isAltnWaypoint: isAltn,
          isMissedAppchWaypoint: isAltn
            ? i >= this.loadedFlightPlan.alternateFlightPlan.firstMissedApproachLegIndex
            : i >= this.loadedFlightPlan.firstMissedApproachLegIndex,
          ident: leg.ident,
          overfly: leg.definition.overfly,
          annotation,
          etaOrSecondsFromPresent: predictionTimestamp(pred?.secondsFromPresent ?? 0),
          transitionAltitude: useTransLevel ? transLevelAsAlt : transAlt,
          altitudePrediction: pred?.altitude ?? null,
          hasAltitudeConstraint: leg.altitudeConstraint !== undefined,
          altitudeConstraint: leg.altitudeConstraint ?? null,
          altitudeConstraintIsRespected: pred?.isAltitudeConstraintMet ?? true,
          speedPrediction: pred?.speed ?? null,
          hasSpeedConstraint: leg.speedConstraint !== undefined,
          speedConstraint: leg.speedConstraint ?? null,
          speedConstraintIsRespected: pred?.isSpeedConstraintMet ?? true,
          efobPrediction: pred?.estimatedFuelOnBoard ? Units.poundToKilogram(pred?.estimatedFuelOnBoard) / 1000.0 : 0,
          windPrediction: this.derivedFplnLegData[i].windPrediction,
          trackFromLastWpt: this.derivedFplnLegData[i].trackFromLastWpt,
          distFromLastWpt: (this.derivedFplnLegData[i].distanceFromLastWpt ?? -reduceDistanceBy) - reduceDistanceBy,
          fpa: leg.definition.verticalAngle ?? null,
        };
        lastDistanceFromStart =
          lastDistanceFromStart + (this.derivedFplnLegData[i].distanceFromLastWpt ?? 0) - reduceDistanceBy;
        lastDistanceFromStart =
          leg?.calculated?.cumulativeDistanceWithTransitions ??
          lastDistanceFromStart + (this.derivedFplnLegData[i].distanceFromLastWpt ?? 0) - reduceDistanceBy;
        this.lineData.push(data);
      } else {
        const data: FplnLineSpecialDisplayData = {
          type: FplnLineType.Special,
          originalLegIndex: isAltn ? i - this.loadedFlightPlan.legCount : i,
          label: 'DISCONTINUITY',
        };
        this.lineData.push(data);
      }

      // Identify end of F-PLN
      if (i === this.loadedFlightPlan.allLegs.length - 1) {
        this.lineData.push({
          type: FplnLineType.Special,
          originalLegIndex: null,
          label: 'END OF F-PLN',
        });

        if (this.loadedFlightPlan.alternateFlightPlan.allLegs.length === 0) {
          this.lineData.push({
            type: FplnLineType.Special,
            originalLegIndex: null,
            label: 'NO ALTN F-PLN',
          });
        }
      }

      // Identify end of ALTN F-PLN
      if (this.loadedFlightPlan.alternateFlightPlan.allLegs.length > 0 && i === jointFlightPlan.length - 1) {
        this.lineData.push({
          type: FplnLineType.Special,
          originalLegIndex: null,
          label: 'END OF ALTN F-PLN',
        });
      }
    }

    // Delete all lines only if re-render is neccessary.
    if (!shouldOnlyUpdatePredictions && this.linesDivRef.getOrDefault()) {
      this.renderedFplnLines.forEach((line) => {
        line.instance.destroy();
      });
      while (this.linesDivRef.instance.firstChild) {
        this.linesDivRef.instance.removeChild(this.linesDivRef.instance.firstChild);
      }
      this.renderedFplnLines = [];
    }

    const untilLegIndex = Math.min(this.lineData.length, startAtIndexChecked + (this.tmpyActive.get() ? 8 : 9));
    for (let drawIndex = startAtIndexChecked; drawIndex < untilLegIndex; drawIndex++) {
      if (drawIndex > this.lineData.length - 1) {
        // Insert empty line
        if (!shouldOnlyUpdatePredictions && this.linesDivRef.getOrDefault()) {
          FSComponent.render(<div />, this.linesDivRef.instance);
        }
      } else {
        const lineIndex = drawIndex - startAtIndexChecked;

        const previousRow = drawIndex > 0 ? this.lineData[drawIndex - 1] : null;
        const previousIsSpecial = previousRow ? previousRow.type === FplnLineType.Special : false;
        const nextRow = drawIndex < this.lineData.length - 1 ? this.lineData[drawIndex + 1] : null;
        const nextIsSpecial = nextRow ? nextRow.type === FplnLineType.Special : false;

        let flags = FplnLineFlags.None;
        if (lineIndex === 0) {
          flags |= FplnLineFlags.FirstLine;
        }
        if (previousIsSpecial) {
          flags |= FplnLineFlags.AfterSpecial;
        }
        if (lineIndex === (this.tmpyActive.get() ? 7 : 8)) {
          flags |= FplnLineFlags.LastLine;
        }
        if (nextIsSpecial) {
          flags |= FplnLineFlags.BeforeSpecial;
        }
        if (drawIndex === this.loadedFlightPlan.activeLegIndex) {
          flags |= FplnLineFlags.IsActiveLeg;
        }
        if (drawIndex === this.loadedFlightPlan.activeLegIndex - 1) {
          flags |= FplnLineFlags.BeforeActiveLeg;
        }

        // No nested attributes, so that's OK
        const clonedLineData = { ...this.lineData[drawIndex] };
        this.renderedLineData[lineIndex].set(clonedLineData);

        if (
          !shouldOnlyUpdatePredictions &&
          this?.renderedLineData[lineIndex]?.get() !== null &&
          this.linesDivRef.getOrDefault()
        ) {
          const lineRef: NodeReference<FplnLegLine> = FSComponent.createRef<FplnLegLine>();
          const node: VNode = (
            <FplnLegLine
              data={this.renderedLineData[lineIndex]}
              ref={lineRef}
              previousRow={Subject.create(previousRow)}
              openRevisionsMenuCallback={() => {
                const line = this.lineData[drawIndex];
                if (line.originalLegIndex !== null) {
                  this.openRevisionsMenu(line.originalLegIndex, isWaypoint(line) ? line.isAltnWaypoint : false);
                }
              }}
              flags={Subject.create(flags)}
              displayEfobAndWind={this.displayEfobAndWind}
              trueTrack={this.trueTrackEnabled}
              globalLineColor={MappedSubject.create(
                ([tmpy, sec]) => {
                  if (sec) {
                    return FplnLineColor.Secondary;
                  }
                  if (tmpy) {
                    return FplnLineColor.Temporary;
                  }
                  return FplnLineColor.Active;
                },
                this.tmpyActive,
                this.secActive,
              )}
              revisionsMenuIsOpened={this.revisionsMenuOpened}
              callbacks={{
                speed: () => this.goToSpeedConstraint(drawIndex),
                altitude: () => this.goToAltitudeConstraint(drawIndex),
                rta: () => this.goToTimeConstraint(drawIndex),
                wind: () => {},
              }}
            />
          );
          FSComponent.render(node, this.linesDivRef.instance);
          this.renderedFplnLines.push(lineRef);
        }
      }
    }

    // Update EFIS/ND
    if (this.lineData.length > 0) {
      // If pseudo-waypoint, find last actual waypoint
      let planCentreLineDataIndex = startAtIndexChecked;
      const isNoPseudoWpt = (data: FplnLineDisplayData) => {
        if (data && isWaypoint(data) && !data.isPseudoWaypoint) {
          return true;
        }
        return false;
      };
      while (this.lineData[planCentreLineDataIndex] && !isNoPseudoWpt(this.lineData[planCentreLineDataIndex])) {
        planCentreLineDataIndex--;
      }

      const planCentreWpt = this.lineData[planCentreLineDataIndex];
      if (planCentreWpt && isWaypoint(planCentreWpt) && planCentreWpt.originalLegIndex !== null) {
        this.props.fmcService.master?.updateEfisPlanCentre(
          this.props.mfd.uiService.captOrFo === 'CAPT' ? 'L' : 'R',
          this.loadedFlightPlanIndex.get(),
          planCentreWpt.originalLegIndex,
          planCentreWpt.isAltnWaypoint,
        );
      }
    }
  }

  private openRevisionsMenu(legIndex: number, altnFlightPlan: boolean) {
    if (!this.revisionsMenuOpened.get()) {
      const flightPlan = altnFlightPlan ? this.loadedFlightPlan?.alternateFlightPlan : this.loadedFlightPlan;
      const leg = flightPlan?.elementAt(legIndex);
      this.props.fmcService.master?.setRevisedWaypoint(legIndex, this.loadedFlightPlanIndex.get(), altnFlightPlan);

      if (leg instanceof FlightPlanLeg) {
        let type: FplnRevisionsMenuType = FplnRevisionsMenuType.Waypoint;
        if (leg.segment.class === SegmentClass.Departure) {
          type = FplnRevisionsMenuType.Departure;
        } else if (leg.segment.class === SegmentClass.Arrival) {
          type = FplnRevisionsMenuType.Arrival;
        }

        this.revisionsMenuValues.set(getRevisionsMenu(this, type));
        this.revisionsMenuRef.getOrDefault()?.display(195, 183);
      } else {
        this.revisionsMenuValues.set(getRevisionsMenu(this, FplnRevisionsMenuType.Discontinuity));
        this.revisionsMenuRef.getOrDefault()?.display(195, 183);
      }
    }
  }

  public openNewDestWindow() {
    this.newDestWindowOpened.set(true);
  }

  public openInsertNextWptFromWindow() {
    const flightPlan = this.props.fmcService.master?.revisedWaypointIsAltn.get()
      ? this.loadedFlightPlan?.alternateFlightPlan
      : this.loadedFlightPlan;
    const wpt: NextWptInfo[] = flightPlan?.allLegs
      .map((el, idx) => {
        const revWptIdx = this.props.fmcService.master?.revisedWaypointIndex.get();
        if (el instanceof FlightPlanLeg && el.isXF() && revWptIdx && idx >= revWptIdx + 1) {
          return { ident: el.ident, originalLegIndex: idx };
        }
        return null;
      })
      .filter((el) => el !== null) as NextWptInfo[];

    if (wpt) {
      this.nextWptAvailableWaypoints.set(wpt);
      this.insertNextWptWindowOpened.set(true);
    }
  }

  public onAfterRender(node: VNode): void {
    super.onAfterRender(node);
    this.onNewData();

    this.subs.push(
      this.displayEfobAndWind.sub((val) => {
        this.efobAndWindButtonDynamicContent.set(val ? this.efobWindButton() : this.spdAltButton());
        this.efobAndWindButtonMenuItems.set([
          {
            action: () => this.displayEfobAndWind.set(!this.displayEfobAndWind.get()),
            label: this.displayEfobAndWind.get()
              ? 'SPD&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ALT'
              : 'EFOB&nbsp;&nbsp;&nbsp;&nbsp;T.WIND',
          },
        ]);
      }, true),
    );

    this.subs.push(
      this.displayFplnFromLineIndex.sub((_) => {
        this.onNewData();
        this.checkScrollButtons();
      }),
    );

    this.subs.push(
      this.tmpyActive.sub((val) => {
        if (this.tmpyLineRef.getOrDefault()) {
          if (val) {
            this.lineColor.set(FplnLineColor.Temporary);
            this.tmpyLineRef.instance.style.display = 'flex';
          } else {
            this.lineColor.set(FplnLineColor.Active);
            this.tmpyLineRef.instance.style.display = 'none';
          }
        }

        this.update(this.displayFplnFromLineIndex.get(), false);
        this.lastRenderedDisplayLineIndex = this.displayFplnFromLineIndex.get();
      }, true),
    );

    if (this.props.mfd.uiService.activeUri.get().extra === 'top') {
      this.scrollToTop();
    } else if (this.props.mfd.uiService.activeUri.get().extra === 'dest') {
      // Scroll to end of FPLN (destination on last line)
      this.scrollToDest();
    }

    const sub = this.props.bus.getSubscriber<ClockEvents>();
    this.subs.push(
      sub
        .on('realTime')
        .atFrequency(0.5)
        .handle((_t) => {
          this.onNewData();
        }),
    );
  }

  checkScrollButtons() {
    // Line index for "FROM" waypoint
    this.disabledScrollUp.set(
      !this.lineData || this.displayFplnFromLineIndex.get() <= (this.loadedFlightPlan?.activeLegIndex ?? 1) - 1,
    );
    this.disabledScrollDown.set(!this.lineData || this.displayFplnFromLineIndex.get() >= this.lineData.length - 1);
  }

  private spdAltButton(): VNode {
    return (
      <div class="mfd-fms-fpln-button-speed-alt">
        <span style="padding-left: 10px;">SPD</span>
        <span style="margin-right: 55px;">ALT</span>
      </div>
    );
  }

  private goToTimeConstraint(lineDataIndex: number) {
    const data = this.lineData[lineDataIndex];
    if (
      isWaypoint(data) &&
      data.originalLegIndex &&
      this.loadedFlightPlan?.legElementAt(data.originalLegIndex) &&
      MfdFmsFplnVertRev.isEligibleForVerticalRevision(
        data.originalLegIndex,
        this.loadedFlightPlan.legElementAt(data.originalLegIndex),
        this.loadedFlightPlan,
      )
    ) {
      this.props.fmcService.master?.setRevisedWaypoint(
        data.originalLegIndex,
        this.loadedFlightPlanIndex.get(),
        data.isAltnWaypoint,
      );
      this.props.mfd.uiService.navigateTo(
        `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-vert-rev/rta`,
      );
    }
  }

  private goToSpeedConstraint(lineDataIndex: number) {
    const data = this.lineData[lineDataIndex];
    if (
      isWaypoint(data) &&
      data.originalLegIndex &&
      this.loadedFlightPlan?.legElementAt(data.originalLegIndex) &&
      MfdFmsFplnVertRev.isEligibleForVerticalRevision(
        data.originalLegIndex,
        this.loadedFlightPlan.legElementAt(data.originalLegIndex),
        this.loadedFlightPlan,
      )
    ) {
      this.props.fmcService.master?.setRevisedWaypoint(
        data.originalLegIndex,
        this.loadedFlightPlanIndex.get(),
        data.isAltnWaypoint,
      );
      this.props.mfd.uiService.navigateTo(
        `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-vert-rev/spd`,
      );
    }
  }

  private goToAltitudeConstraint(lineDataIndex: number) {
    const data = this.lineData[lineDataIndex];
    if (
      isWaypoint(data) &&
      data.originalLegIndex &&
      this.loadedFlightPlan?.legElementAt(data.originalLegIndex) &&
      MfdFmsFplnVertRev.isEligibleForVerticalRevision(
        data.originalLegIndex,
        this.loadedFlightPlan.legElementAt(data.originalLegIndex),
        this.loadedFlightPlan,
      )
    ) {
      this.props.fmcService.master?.setRevisedWaypoint(
        data.originalLegIndex,
        this.loadedFlightPlanIndex.get(),
        data.isAltnWaypoint,
      );
      this.props.mfd.uiService.navigateTo(
        `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-vert-rev/alt`,
      );
    }
  }

  private efobWindButton(): VNode {
    return (
      <div class="mfd-fms-fpln-button-speed-alt">
        <span>EFOB</span>
        <span style="margin-left: 30px;">T.WIND</span>
      </div>
    );
  }

  private scrollToTop() {
    if (!this.loadedFlightPlan) {
      return;
    }

    this.update(this.loadedFlightPlan.activeLegIndex, false);
    this.checkScrollButtons();
    if (this.lineData) {
      const whichLineIndex = this.lineData.findIndex(
        (it) => it && it.originalLegIndex === this.loadedFlightPlan?.activeLegIndex,
      );
      this.displayFplnFromLineIndex.set(Math.max(whichLineIndex - 1, 0));
    }
  }

  private scrollToDest() {
    if (!this.loadedFlightPlan) {
      return;
    }

    this.update(this.loadedFlightPlan.activeLegIndex, false);
    this.checkScrollButtons();
    if (this.lineData) {
      const whichLineIndex =
        this.lineData.findIndex((it) => it && it.originalLegIndex === this.loadedFlightPlan?.destinationLegIndex) + 1;
      if (whichLineIndex === -1) {
        this.displayFplnFromLineIndex.set(0);
      } else {
        this.displayFplnFromLineIndex.set(whichLineIndex - (this.tmpyActive.get() ? 8 : 9));
      }
    }
  }

  render(): VNode {
    return (
      <>
        {super.render()}
        {/* begin page content */}
        <div class="mfd-page-container">
          <ContextMenu
            ref={this.revisionsMenuRef}
            idPrefix={`${this.props.mfd.uiService.captOrFo}_MFD_revisionsMenu`}
            values={this.revisionsMenuValues}
            opened={this.revisionsMenuOpened}
          />
          <DestinationWindow
            fmcService={this.props.fmcService}
            mfd={this.props.mfd}
            visible={this.newDestWindowOpened}
          />
          <InsertNextWptFromWindow
            fmcService={this.props.fmcService}
            mfd={this.props.mfd}
            availableWaypoints={this.nextWptAvailableWaypoints}
            visible={this.insertNextWptWindowOpened}
            captOrFo={this.props.mfd.uiService.captOrFo}
          />
          <div class="mfd-fms-fpln-header">
            <div class="mfd-fms-fpln-header-from">
              <span class="mfd-label">FROM</span>
            </div>
            <div class="mfd-fms-fpln-header-time">
              <span class="mfd-label">TIME</span>
            </div>
            <div ref={this.spdAltEfobWindRef} class="mfd-fms-fpln-header-speed-alt">
              <Button
                label={this.efobAndWindButtonDynamicContent}
                onClick={() => {}}
                buttonStyle="margin-right: 5px; width: 260px; height: 43px;"
                idPrefix={`${this.props.mfd.uiService.captOrFo}_MFD_efobwindbtn`}
                menuItems={this.efobAndWindButtonMenuItems}
              />
            </div>
            <div class="mfd-fms-fpln-header-trk">
              <span class="mfd-label">TRK</span>
            </div>
            <div class="mfd-fms-fpln-header-dist">
              <span class="mfd-label">DIST</span>
            </div>
            <div class="mfd-fms-fpln-header-fpa">
              <span class="mfd-label">FPA</span>
            </div>
          </div>
          <div ref={this.linesDivRef} />
          <div style="flex-grow: 1" />
          <div ref={this.tmpyLineRef} class="mfd-fms-fpln-line-erase-temporary">
            <Button
              label={Subject.create(
                <div style="display: flex; flex-direction: row; justify-content: space-between;">
                  <span style="text-align: center; vertical-align: center; margin-right: 10px;">
                    ERASE
                    <br />
                    TMPY
                  </span>
                  <span style="display: flex; align-items: center; justify-content: center;">*</span>
                </div>,
              )}
              onClick={() => this.props.fmcService.master?.flightPlanService.temporaryDelete()}
              buttonStyle="color: #e68000; padding-right: 2px;"
            />
            <Button
              label={Subject.create(
                <div style="display: flex; flex-direction: row; justify-content: space-between;">
                  <span style="text-align: center; vertical-align: center; margin-right: 10px;">
                    INSERT
                    <br />
                    TMPY
                  </span>
                  <span style="display: flex; align-items: center; justify-content: center;">*</span>
                </div>,
              )}
              onClick={() => this.props.fmcService.master?.flightPlanService.temporaryInsert()}
              buttonStyle="color: #e68000; padding-right: 2px;"
            />
          </div>
          <div style="flex-grow: 1;" />
          {/* fill space vertically */}
          <div class="mfd-fms-fpln-line-destination">
            <Button
              label={this.destButtonLabel.map((it) => (
                <span>{it}</span>
              ))}
              onClick={() => {
                this.props.fmcService.master?.resetRevisedWaypoint();
                this.props.mfd.uiService.navigateTo(
                  `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-arrival`,
                );
              }}
              buttonStyle="font-size: 30px; width: 150px; margin-right: 5px;"
            />
            <span
              class={{
                'mfd-label': true,
                'mfd-fms-yellow-text': this.lineColor.map((it) => it === FplnLineColor.Temporary),
              }}
            >
              {this.destTimeLabel}
            </span>
            <div class="mfd-label-value-container">
              <span
                class={{
                  'mfd-label': true,
                  'mfd-fms-yellow-text': this.lineColor.map((it) => it === FplnLineColor.Temporary),
                }}
              >
                {this.destEfob}
              </span>
              <span class="mfd-label-unit mfd-unit-trailing">T</span>
            </div>
            <div class="mfd-label-value-container">
              <span
                class={{
                  'mfd-label': true,
                  'mfd-fms-yellow-text': this.lineColor.map((it) => it === FplnLineColor.Temporary),
                }}
              >
                {this.destDistanceLabel}
              </span>
              <span class="mfd-label-unit mfd-unit-trailing">NM</span>
            </div>
            <div style="display: flex; flex-direction: row; margin-top: 5px; margin-bottom: 5px;">
              <IconButton
                icon="double-down"
                onClick={() => this.displayFplnFromLineIndex.set(this.displayFplnFromLineIndex.get() + 1)}
                disabled={this.disabledScrollDown}
                containerStyle="width: 60px; height: 60px;"
              />
              <IconButton
                icon="double-up"
                onClick={() => this.displayFplnFromLineIndex.set(this.displayFplnFromLineIndex.get() - 1)}
                disabled={this.disabledScrollUp}
                containerStyle="width: 60px; height: 60px;"
              />
              <Button
                label="DEST"
                disabled={this.destButtonDisabled}
                onClick={() => this.scrollToDest()}
                buttonStyle="height: 60px; margin-right: 5px; padding: auto 15px auto 15px;"
              />
            </div>
          </div>
          <div class="mfd-fms-fpln-footer">
            <Button
              label="INIT"
              onClick={() =>
                this.props.mfd.uiService.navigateTo(`fms/${this.props.mfd.uiService.activeUri.get().category}/init`)
              }
              buttonStyle="width: 125px;"
            />
            <Button
              disabled={Subject.create(true)}
              label="F-PLN INFO"
              onClick={() => {}}
              idPrefix={`${this.props.mfd.uiService.captOrFo}_MFD_f-pln-infoBtn`}
              menuItems={Subject.create([
                {
                  label: 'ALTERNATE',
                  action: () =>
                    this.props.mfd.uiService.navigateTo(
                      `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-alternate`,
                    ),
                },
                {
                  label: 'CLOSEST AIRPORTS',
                  action: () =>
                    this.props.mfd.uiService.navigateTo(
                      `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-closest-airports`,
                    ),
                },
                {
                  label: 'EQUI-TIME POINT',
                  action: () =>
                    this.props.mfd.uiService.navigateTo(
                      `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-equi-time-point`,
                    ),
                },
                {
                  label: 'FIX INFO',
                  action: () =>
                    this.props.mfd.uiService.navigateTo(
                      `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-fix-info`,
                    ),
                },
                {
                  label: 'LL CROSSING',
                  action: () =>
                    this.props.mfd.uiService.navigateTo(
                      `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-ll-xing-time-mkr`,
                    ),
                },
                {
                  label: 'TIME MARKER',
                  action: () =>
                    this.props.mfd.uiService.navigateTo(
                      `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-ll-xing-time-mkr`,
                    ),
                },
                {
                  label: 'CPNY F-PLN REPORT',
                  action: () => {},
                },
              ])}
            />
            <Button
              label="DIR TO"
              onClick={() =>
                this.props.mfd.uiService.navigateTo(
                  `fms/${this.props.mfd.uiService.activeUri.get().category}/f-pln-direct-to`,
                )
              }
              buttonStyle="margin-right: 5px;"
            />
          </div>
          {/* end page content */}
        </div>
        <Footer bus={this.props.bus} mfd={this.props.mfd} fmcService={this.props.fmcService} />
      </>
    );
  }
}

interface FplnLineCommonProps extends ComponentProps {
  openRevisionsMenuCallback: () => void;
}
enum FplnLineColor {
  Active = '#00ff00',
  Temporary = '#ffff00',
  Secondary = '#ffffff',
  Alternate = '#00ffff',
}

enum FplnLineFlags {
  None = 0,
  FirstLine = 1 << 0,
  BeforeSpecial = 1 << 1,
  AfterSpecial = 1 << 2,
  BeforeActiveLeg = 1 << 3,
  IsActiveLeg = 1 << 4,
  LastLine = 1 << 5,
}

enum FplnLineType {
  Waypoint,
  Special,
  Hold,
}

interface FplnLineTypeDiscriminator {
  /*
   * waypoint: Regular or pseudo waypoints
   * special: DISCONTINUITY, END OF F-PLN etc.
   */
  type: FplnLineType;
  originalLegIndex: number | null;
}

// Type for DISCO, END OF F-PLN etc.
interface FplnLineSpecialDisplayData extends FplnLineTypeDiscriminator {
  // type: FplnLineType.Special;
  label: string;
}

export interface FplnLineWaypointDisplayData extends FplnLineTypeDiscriminator {
  // type: FplnLineType.Waypoint;
  isPseudoWaypoint: boolean;
  isAltnWaypoint: boolean;
  isMissedAppchWaypoint: boolean;
  ident: string;
  overfly: boolean;
  annotation: string;
  etaOrSecondsFromPresent: number; // timestamp, will be printed to HH:mm
  transitionAltitude: number;
  altitudePrediction: number | null;
  hasAltitudeConstraint: boolean;
  altitudeConstraint: AltitudeConstraint | null;
  altitudeConstraintIsRespected: boolean;
  speedPrediction: number | null;
  hasSpeedConstraint: boolean;
  speedConstraint: SpeedConstraint | null;
  speedConstraintIsRespected: boolean;
  efobPrediction: number;
  windPrediction: WindVector | null;
  trackFromLastWpt?: number | null;
  distFromLastWpt: number | null;
  fpa: number | null;
}

interface FplnLineHoldDisplayData extends FplnLineTypeDiscriminator {
  // type: FplnLineType.Hold;
  isPseudoWaypoint: boolean;
  isAltnWaypoint: boolean;
  isMissedAppchWaypoint: boolean;
  ident: string;
  holdSpeed: number;
  distFromLastWpt: number | null;
}

type FplnLineDisplayData = FplnLineWaypointDisplayData | FplnLineSpecialDisplayData | FplnLineHoldDisplayData;

function isWaypoint(object: FplnLineDisplayData): object is FplnLineWaypointDisplayData {
  return object?.type === FplnLineType.Waypoint;
}

function isSpecial(object: FplnLineDisplayData): object is FplnLineSpecialDisplayData {
  return object?.type === FplnLineType.Special;
}

function isHold(object: FplnLineDisplayData): object is FplnLineHoldDisplayData {
  return object?.type === FplnLineType.Hold;
}

type lineConstraintsCallbacks = {
  speed: () => void;
  rta: () => void;
  altitude: () => void;
  wind: () => void;
};

export interface FplnLegLineProps extends FplnLineCommonProps {
  previousRow: Subscribable<FplnLineDisplayData | null>;
  data: Subscribable<FplnLineDisplayData | null>;
  flags: Subscribable<FplnLineFlags>;
  displayEfobAndWind: Subscribable<boolean>;
  trueTrack: Subscribable<boolean>;
  globalLineColor: Subscribable<FplnLineColor>;
  revisionsMenuIsOpened: Subject<boolean>;
  callbacks: lineConstraintsCallbacks;
}

class FplnLegLine extends DisplayComponent<FplnLegLineProps> {
  // Make sure to collect all subscriptions here, so we can properly destroy them.
  private subs = [] as Subscription[];

  private selectedForRevision = Subject.create(false);

  private lineColor = MappedSubject.create(
    ([color, data]) => {
      if (data && (isWaypoint(data) || isHold(data)) && (data.isAltnWaypoint || data.isMissedAppchWaypoint)) {
        return FplnLineColor.Alternate;
      }
      return color;
    },
    this.props.globalLineColor,
    this.props.data,
  );

  private topRef = FSComponent.createRef<HTMLDivElement>();

  private lineRef = FSComponent.createRef<HTMLDivElement>();

  private currentlyRenderedType: FplnLineType = FplnLineType.Waypoint;

  private annotationRef = FSComponent.createRef<HTMLDivElement>();

  private identRef = FSComponent.createRef<HTMLDivElement | HTMLSpanElement>();

  private timeRef = FSComponent.createRef<HTMLDivElement>();

  private speedRef = FSComponent.createRef<HTMLDivElement>();

  private altRef = FSComponent.createRef<HTMLDivElement>();

  private connectorRef = FSComponent.createRef<HTMLDivElement>();

  private trackRef = FSComponent.createRef<HTMLDivElement>();

  private distRef = FSComponent.createRef<HTMLDivElement>();

  private fpaRef = FSComponent.createRef<HTMLDivElement>();

  private allRefs: NodeReference<HTMLElement>[] = [
    this.annotationRef,
    this.identRef,
    this.timeRef,
    this.speedRef,
    this.altRef,
    this.connectorRef,
    this.trackRef,
    this.distRef,
    this.fpaRef,
  ];

  public onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.subs.push(
      this.props.flags.sub((val) => {
        if (FplnLineFlags.IsActiveLeg === (val & FplnLineFlags.IsActiveLeg)) {
          this.allRefs.forEach((ref) => ref.getOrDefault()?.classList.add('mfd-fms-fpln-leg-active'));
        } else {
          this.allRefs.forEach((ref) => ref.getOrDefault()?.classList.remove('mfd-fms-fpln-leg-active'));
        }
      }, true),
    );

    this.subs.push(
      this.props.displayEfobAndWind.sub(() => {
        const data = this.props.data.get();
        if (data && isWaypoint(data)) {
          this.renderSpdAltEfobWind(data);
        }
      }, true),
    );

    this.subs.push(this.props.data.sub((data) => data && this.onNewData(data), true));

    this.subs.push(
      this.selectedForRevision.sub((val) => {
        if (val) {
          this.identRef.getOrDefault()?.classList.add('selected');
        } else {
          this.identRef.getOrDefault()?.classList.remove('selected');
        }
      }),
    );

    this.subs.push(
      this.props.revisionsMenuIsOpened.sub((val) => {
        if (!val) {
          this.selectedForRevision.set(false);
          this.identRef.getOrDefault()?.classList.remove('selected');
        }
      }),
    );

    this.identRef.getOrDefault()?.addEventListener('click', () => {
      if (this.props.data.get()?.originalLegIndex !== null) {
        this.props.openRevisionsMenuCallback();
        this.selectedForRevision.set(true);
      }
    });

    this.timeRef.getOrDefault()?.parentElement?.addEventListener('click', () => this.props.callbacks.rta());
  }

  public destroy(): void {
    this.subs.forEach((sub) => sub.destroy());
    this.lineColor.destroy();
    super.destroy();
  }

  private onNewData(data: FplnLineDisplayData): void {
    if (data && isWaypoint(data) && this.topRef.getOrDefault()) {
      if (this.currentlyRenderedType !== FplnLineType.Waypoint) {
        while (this.topRef.instance.firstChild) {
          this.topRef.instance.removeChild(this.topRef.instance.firstChild);
        }
        FSComponent.render(this.renderWaypointLine(), this.topRef.instance);
        this.currentlyRenderedType = FplnLineType.Waypoint;
      }

      if (this.identRef.getOrDefault()) {
        if (data.overfly) {
          this.identRef.instance.innerHTML = `<span>${data.ident}<span style="font-size: 24px; vertical-align: baseline;">@</span></span>`;
        } else {
          this.identRef.instance.innerText = data.ident;
        }
      }

      // TODO: RNP info
      if (this.annotationRef.getOrDefault()) {
        this.annotationRef.instance.innerText = data.annotation;
      }

      // Format time to leg
      // TODO: Time constraint, "HOLD SPD" label
      if (this.timeRef.getOrDefault()) {
        if (this.props.globalLineColor.get() === FplnLineColor.Active) {
          if (data.etaOrSecondsFromPresent) {
            const date = new Date(data.etaOrSecondsFromPresent);
            this.timeRef.instance.innerText = `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}`;
          }
        } else {
          this.timeRef.instance.innerText = '--:--';
        }
      }

      this.renderSpdAltEfobWind(data);

      if (this.connectorRef.getOrDefault()) {
        while (this.connectorRef.instance.firstChild) {
          this.connectorRef.instance.removeChild(this.connectorRef.instance.firstChild);
        }
        FSComponent.render(this.lineConnector(data), this.connectorRef.instance);
      }

      if (this.trackRef.getOrDefault() && this.distRef.getOrDefault() && this.fpaRef.getOrDefault()) {
        if (FplnLineFlags.AfterSpecial === (this.props.flags.get() & FplnLineFlags.AfterSpecial)) {
          this.trackRef.instance.innerText = '';
          this.distRef.instance.innerText = '';
          this.fpaRef.instance.innerText = '';
        } else {
          this.trackRef.instance.innerText = data.trackFromLastWpt
            ? `${data.trackFromLastWpt.toFixed(0)}°${this.props.trueTrack.get() ? 'T' : ''}`
            : '';
          this.distRef.instance.innerText = data.distFromLastWpt?.toFixed(0) ?? '';
          this.fpaRef.instance.innerText = data.fpa ? data.fpa.toFixed(1) : '';
        }
      }
    } else if (data && isSpecial(data) && this.identRef.getOrDefault()) {
      if (this.currentlyRenderedType !== FplnLineType.Special) {
        while (this.topRef.instance.firstChild) {
          this.topRef.instance.removeChild(this.topRef.instance.firstChild);
        }
        FSComponent.render(this.renderSpecialLine(data), this.topRef.instance);
        this.currentlyRenderedType = FplnLineType.Special;
      }

      const delimiter = data.label.length > 13 ? '- - - - -' : '- - - - - - ';
      this.identRef.instance.innerHTML = `${delimiter}<span style="margin: 0px 15px 0px 15px;">${data.label}</span>${delimiter}`;
    } else if (data && isHold(data) && this.identRef.getOrDefault() && this.timeRef.getOrDefault()) {
      if (this.currentlyRenderedType !== FplnLineType.Waypoint) {
        while (this.topRef.instance.firstChild) {
          this.topRef.instance.removeChild(this.topRef.instance.firstChild);
        }
        FSComponent.render(this.renderWaypointLine(), this.topRef.instance);
        this.currentlyRenderedType = FplnLineType.Waypoint;
      }

      this.identRef.instance.innerText = data.ident;
      this.timeRef.instance.innerText = 'SPD';

      if (this.connectorRef.getOrDefault()) {
        while (this.connectorRef.instance.firstChild) {
          this.connectorRef.instance.removeChild(this.connectorRef.instance.firstChild);
        }
        FSComponent.render(FplnLineConnectorHold(this.lineColor.get()), this.connectorRef.instance);
      }

      if (this.trackRef.getOrDefault() && this.distRef.getOrDefault() && this.fpaRef.getOrDefault()) {
        this.trackRef.instance.innerText = '';
        this.distRef.instance.innerText = '';
        this.fpaRef.instance.innerText = '';
      }
    }
  }

  private renderSpdAltEfobWind(data: FplnLineWaypointDisplayData): void {
    if (!this.speedRef.getOrDefault() || !this.altRef.getOrDefault()) {
      return;
    }

    while (this.speedRef.instance.firstChild) {
      this.speedRef.instance.parentElement?.removeEventListener('click', () => this.props.callbacks.speed());
      this.speedRef.instance.removeChild(this.speedRef.instance.firstChild);
    }
    while (this.altRef.instance.firstChild) {
      this.altRef.instance.parentElement?.removeEventListener('click', () => this.props.callbacks.altitude());
      this.altRef.instance.parentElement?.removeEventListener('click', () => this.props.callbacks.wind());
      this.altRef.instance.removeChild(this.altRef.instance.firstChild);
    }
    FSComponent.render(this.efobOrSpeed(data), this.speedRef.instance);
    FSComponent.render(this.windOrAlt(data), this.altRef.instance);

    if (this.props.displayEfobAndWind.get()) {
      this.altRef.instance.style.alignSelf = 'flex-end';
      this.altRef.instance.style.paddingRight = '20px';
      this.altRef.instance.parentElement?.addEventListener('click', () => this.props.callbacks.wind());
      this.speedRef.instance.style.paddingLeft = '10px';
      if (this.speedRef.instance.parentElement) {
        this.speedRef.instance.parentElement.className = 'mfd-fms-fpln-label-small';
      }
    } else {
      this.altRef.instance.style.alignSelf = '';
      this.altRef.instance.style.paddingRight = '';
      this.altRef.instance.parentElement?.addEventListener('click', () => this.props.callbacks.altitude());
      this.speedRef.instance.style.paddingLeft = '';
      this.speedRef.instance.parentElement?.addEventListener('click', () => this.props.callbacks.speed());
      if (this.speedRef.instance.parentElement) {
        this.speedRef.instance.parentElement.className = 'mfd-fms-fpln-label-small-clickable';
      }
    }
  }

  private formatWind(data: FplnLineWaypointDisplayData): VNode {
    let directionStr = '---';
    const previousRow = this.props.previousRow.get();
    if (
      previousRow &&
      isWaypoint(previousRow) &&
      previousRow.windPrediction?.direction === data.windPrediction?.direction &&
      !(
        FplnLineFlags.AfterSpecial === (this.props.flags.get() & FplnLineFlags.AfterSpecial) ||
        FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)
      )
    ) {
      directionStr = <span style="font-family: HoneywellMCDU, monospace;">"</span>;
    } else {
      directionStr = <span>{data.windPrediction?.direction.toFixed(0).toString().padStart(3, '0')}</span>;
    }

    let speedStr = '--';
    if (previousRow && isWaypoint(previousRow) && previousRow.windPrediction?.speed === data.windPrediction?.speed) {
      speedStr = <span style="font-family: HoneywellMCDU, monospace;">"</span>;
    } else {
      speedStr = <span>{data.windPrediction?.speed.toFixed(0).toString().padStart(3, '0')}</span>;
    }

    return (
      <div style="display: flex; flex-direction: row; justify-self: flex-end">
        <div style="width: 45px; text-align: center;">{directionStr}</div>
        <span>/</span>
        <div style="width: 45px; text-align: center;">{speedStr}</div>
      </div>
    );
  }

  private formatAltitude(data: FplnLineWaypointDisplayData): VNode {
    let altStr: VNode = <span>-----</span>;
    const previousRow = this.props.previousRow.get();
    if (data.altitudePrediction) {
      const isBelowTransAlt = data.altitudePrediction < (data.transitionAltitude ?? 18_000);
      if (
        previousRow &&
        isWaypoint(previousRow) &&
        previousRow.altitudePrediction &&
        Math.abs(previousRow.altitudePrediction - data.altitudePrediction) < 100 &&
        !data.hasAltitudeConstraint &&
        !(
          FplnLineFlags.AfterSpecial === (this.props.flags.get() & FplnLineFlags.AfterSpecial) ||
          FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)
        )
      ) {
        altStr = <span style="font-family: HoneywellMCDU, monospace;">"</span>;
      } else if (!isBelowTransAlt) {
        altStr = <span>{`FL${Math.round(data.altitudePrediction / 100).toString()}`}</span>;
      } else {
        altStr = <span>{data.altitudePrediction.toFixed(0)}</span>;
      }
    }
    if (data.hasAltitudeConstraint && data.altitudePrediction) {
      if (data.altitudeConstraintIsRespected) {
        return (
          <>
            <span class="mfd-fms-fpln-leg-constraint-respected">*</span>
            <span>{altStr}</span>
          </>
        );
      }
      return (
        <>
          <span class="mfd-fms-fpln-leg-constraint-missed">*</span>
          <span>{altStr}</span>
        </>
      );
    }
    if (data.hasAltitudeConstraint && data.altitudeConstraint?.altitude1 && !data.altitudePrediction) {
      const isBelowTransAlt = data.altitudeConstraint.altitude1 < (data.transitionAltitude ?? 18_000);
      const altCstr = isBelowTransAlt
        ? data.altitudeConstraint.altitude1.toFixed(0)
        : `FL${Math.round(data.altitudeConstraint.altitude1 / 100).toString()}`;
      let cstrType = '';
      if (
        data.altitudeConstraint.altitudeDescriptor &&
        [
          AltitudeDescriptor.AtOrAboveAlt1,
          AltitudeDescriptor.AtOrAboveAlt1AngleAlt2,
          AltitudeDescriptor.AtOrAboveAlt1GsIntcptAlt2,
          AltitudeDescriptor.AtOrAboveAlt1GsMslAlt2,
        ].includes(data.altitudeConstraint.altitudeDescriptor)
      ) {
        cstrType = '+';
      } else if (
        data.altitudeConstraint.altitudeDescriptor &&
        [AltitudeDescriptor.AtOrBelowAlt1, AltitudeDescriptor.AtOrBelowAlt1AngleAlt2].includes(
          data.altitudeConstraint.altitudeDescriptor,
        )
      ) {
        cstrType = '-';
      }
      const displayedStr = data.altitudeConstraint.altitude2 ? 'WINDOW' : `${cstrType}${altCstr}`;
      return (
        <span class="mfd-fms-fpln-leg-constraint-respected" style="font-size: 25px;">
          {displayedStr}
        </span>
      );
    }
    return <span style="margin-left: 20px;">{altStr}</span>;
  }

  private formatSpeed(data: FplnLineWaypointDisplayData): VNode {
    let speedStr: VNode = <span>---</span>;
    const previousRow = this.props.previousRow.get();
    if (
      previousRow &&
      isWaypoint(previousRow) &&
      data.speedPrediction &&
      previousRow.speedPrediction &&
      ((data.speedPrediction >= 2 && Math.abs(previousRow.speedPrediction - data.speedPrediction) < 1) ||
        (data.speedPrediction < 2 && Math.abs(previousRow.speedPrediction - data.speedPrediction) < 0.01)) &&
      !data.hasSpeedConstraint &&
      !(
        FplnLineFlags.AfterSpecial === (this.props.flags.get() & FplnLineFlags.AfterSpecial) ||
        FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)
      )
    ) {
      speedStr = <span style="font-family: HoneywellMCDU, monospace; padding-left: 3px; padding-right: 3px;">"</span>;
    } else if (data.speedPrediction && Number.isFinite(data.speedPrediction) && data.speedPrediction > 0) {
      speedStr = (
        <span>
          {data.speedPrediction > 2
            ? data.speedPrediction.toFixed(0)
            : `.${data.speedPrediction.toFixed(2).split('.')[1]}`}
        </span>
      );
    }

    if (data.hasSpeedConstraint && data.speedPrediction) {
      if (data.speedConstraintIsRespected) {
        return (
          <>
            <span class="mfd-fms-fpln-leg-constraint-respected">*</span>
            <span>{speedStr}</span>
          </>
        );
      }
      return (
        <>
          <span class="mfd-fms-fpln-leg-constraint-missed">*</span>
          <span>{speedStr}</span>
        </>
      );
    }
    if (data.hasSpeedConstraint && data.speedConstraint?.speed && !data.speedPrediction) {
      return (
        <span class="mfd-fms-fpln-leg-constraint-respected" style="margin-left: 20px; font-size: 25px;">
          {data.speedConstraint.speed > 2
            ? data.speedConstraint.speed.toFixed(0)
            : `.${data.speedConstraint.speed.toFixed(2).split('.')[1]}`}
        </span>
      );
    }
    return <span style="margin-left: 20px;">{speedStr}</span>;
  }

  private efobOrSpeed(data: FplnLineWaypointDisplayData): VNode {
    if (this.props.displayEfobAndWind.get()) {
      return data.efobPrediction && this.props.globalLineColor.get() === FplnLineColor.Active ? (
        <span>{(data.efobPrediction / 1000).toFixed(1)}</span>
      ) : (
        <span>--.-</span>
      );
    }
    return this.props.globalLineColor.get() === FplnLineColor.Active ? this.formatSpeed(data) : <span>---</span>;
  }

  private windOrAlt(data: FplnLineWaypointDisplayData): VNode {
    if (this.props.displayEfobAndWind.get()) {
      return this.props.globalLineColor.get() === FplnLineColor.Active ? this.formatWind(data) : <span>---°/---</span>;
    }
    return this.props.globalLineColor.get() === FplnLineColor.Active ? this.formatAltitude(data) : <span>-----</span>;
  }

  private lineConnector(data: FplnLineWaypointDisplayData): VNode {
    if (
      FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine) &&
      FplnLineFlags.BeforeActiveLeg === (this.props.flags.get() & FplnLineFlags.BeforeActiveLeg)
    ) {
      return <></>;
    }
    if (FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)) {
      return FplnLineConnectorFirstLineNotBeforeActiveLeg(
        this.lineColor.get(),
        FplnLineFlags.IsActiveLeg === (this.props.flags.get() & FplnLineFlags.IsActiveLeg),
        FplnLineFlags.BeforeSpecial === (this.props.flags.get() & FplnLineFlags.BeforeSpecial),
      );
    }
    if (FplnLineFlags.AfterSpecial === (this.props.flags.get() & FplnLineFlags.AfterSpecial)) {
      const lastLineOrBeforeSpecial =
        FplnLineFlags.LastLine === (this.props.flags.get() & FplnLineFlags.LastLine) ||
        FplnLineFlags.BeforeSpecial === (this.props.flags.get() & FplnLineFlags.BeforeSpecial);
      return FplnLineConnectorNormalNotBeforeActiveLeg(this.lineColor.get(), lastLineOrBeforeSpecial);
    }
    if (FplnLineFlags.IsActiveLeg === (this.props.flags.get() & FplnLineFlags.IsActiveLeg)) {
      return FplnLineConnectorActiveLeg(this.lineColor.get());
    }
    if (data.isPseudoWaypoint) {
      const lastLineOrBeforeSpecial =
        FplnLineFlags.LastLine === (this.props.flags.get() & FplnLineFlags.LastLine) ||
        FplnLineFlags.BeforeSpecial === (this.props.flags.get() & FplnLineFlags.BeforeSpecial);
      return FplnLineConnectorPseudoWaypoint(this.lineColor.get(), lastLineOrBeforeSpecial);
    }
    const lastLineOrBeforeSpecial =
      FplnLineFlags.LastLine === (this.props.flags.get() & FplnLineFlags.LastLine) ||
      FplnLineFlags.BeforeSpecial === (this.props.flags.get() & FplnLineFlags.BeforeSpecial);
    return FplnLineConnectorNormal(this.lineColor.get(), lastLineOrBeforeSpecial);
  }

  renderWaypointLine(): VNode {
    return (
      <div
        ref={this.lineRef}
        class={{
          'mfd-fms-fpln-line': true,
          'mfd-fms-fpln-line-temporary': this.lineColor.map((it) => it === FplnLineColor.Temporary),
          'mfd-fms-fpln-line-secondary': this.lineColor.map((it) => it === FplnLineColor.Secondary),
          'mfd-fms-fpln-line-altn': this.lineColor.map((it) => it === FplnLineColor.Alternate),
        }}
        style={`${FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine) ? 'height: 40px; margin-top: 16px;' : 'height: 72px;'};`}
      >
        <div style="width: 25%; display: flex; flex-direction: column;">
          {!(FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)) && (
            <div ref={this.annotationRef} class="mfd-fms-fpln-line-annotation" />
          )}
          <div ref={this.identRef} class="mfd-fms-fpln-line-ident" />
        </div>
        <div class="mfd-fms-fpln-label-small-clickable" style="width: 11.5%;">
          {!(FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)) && (
            <div class="mfd-fms-fpln-leg-upper-row" />
          )}
          <div ref={this.timeRef} class="mfd-fms-fpln-leg-lower-row" />
        </div>
        <div
          class="mfd-fms-fpln-label-small-clickable"
          style="width: 15%; align-items: flex-start; padding-left: 40px;"
          onclick={() => this.props.callbacks.speed()}
        >
          {!(FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)) && (
            <div class="mfd-fms-fpln-leg-upper-row" />
          )}
          <div ref={this.speedRef} class="mfd-fms-fpln-leg-lower-row" />
        </div>
        <div
          class="mfd-fms-fpln-label-small-clickable"
          style="width: 21%; align-items: flex-start; padding-left: 20px;"
          onclick={() => this.props.callbacks.altitude()}
        >
          {!(FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)) && (
            <div class="mfd-fms-fpln-leg-upper-row" />
          )}
          <div ref={this.altRef} class="mfd-fms-fpln-leg-lower-row" />
        </div>
        <div ref={this.connectorRef} class="mfd-fms-fpln-label-small" style="width: 30px; margin-right: 5px;" />
        <div class="mfd-fms-fpln-label-small" style="width: 9%; align-items: flex-start;">
          {!(FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)) && (
            <div ref={this.trackRef} class="mfd-fms-fpln-leg-upper-row" />
          )}
          <div class="mfd-fms-fpln-leg-lower-row" />
        </div>
        <div class="mfd-fms-fpln-label-small" style="width: 6%; align-items: flex-end;">
          {!(FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)) && (
            <div ref={this.distRef} class="mfd-fms-fpln-leg-upper-row" />
          )}
          <div class="mfd-fms-fpln-leg-lower-row" />
        </div>
        <div class="mfd-fms-fpln-label-small" style="width: 8%; align-items: flex-end;">
          {!(FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine)) && (
            <div ref={this.fpaRef} class="mfd-fms-fpln-leg-upper-row" />
          )}
          <div class="mfd-fms-fpln-leg-lower-row" />
        </div>
      </div>
    );
  }

  renderSpecialLine(data: FplnLineSpecialDisplayData) {
    const delimiter = data.label.length > 13 ? '- - - - -' : '- - - - - - ';
    return (
      <div
        ref={this.identRef}
        class="mfd-fms-fpln-line mfd-fms-fpln-line-special"
        style={`font-size: 30px; ${FplnLineFlags.FirstLine === (this.props.flags.get() & FplnLineFlags.FirstLine) ? 'height: 40px; margin-top: 16px;' : 'height: 72px;'};`}
      >
        {delimiter}
        <span style="margin: 0px 15px 0px 15px;">{data.label}</span>
        {delimiter}
      </div>
    );
  }

  render() {
    const data = this.props.data.get();
    if (data && isWaypoint(data)) {
      this.currentlyRenderedType = FplnLineType.Waypoint;
      return <div ref={this.topRef}>{this.renderWaypointLine()}</div>;
    }
    if (data && isSpecial(data)) {
      this.currentlyRenderedType = FplnLineType.Special;
      return <div ref={this.topRef}>{this.renderSpecialLine(data)}</div>;
    }
    if (data && isHold(data)) {
      this.currentlyRenderedType = FplnLineType.Hold;
      return <div ref={this.topRef}>{this.renderWaypointLine()}</div>;
    }
    return <></>;
  }
}

function FplnLineConnectorFirstLineNotBeforeActiveLeg(
  lineColor: FplnLineColor,
  activeLeg: boolean,
  beforeSpecial: boolean,
): VNode {
  return (
    <svg height="40" width="30">
      <line x1="15" y1="40" x2="15" y2="30" style={`stroke:${beforeSpecial ? '#000' : lineColor};stroke-width:2`} />
      <line
        x1="8"
        y1="18"
        x2="0"
        y2="18"
        style={`stroke:${activeLeg && lineColor === FplnLineColor.Active ? '#fff' : lineColor};stroke-width:2`}
      />
      <g
        style={`fill:none;stroke:${activeLeg && lineColor !== FplnLineColor.Temporary ? '#fff' : lineColor};stroke-width:2`}
      >
        <polyline points="15,31 8,19 15,5 22,19 15,31" />
      </g>
    </svg>
  );
}

function FplnLineConnectorNormal(lineColor: FplnLineColor, lastLine: boolean): VNode {
  return (
    <svg height="72" width="30">
      <line x1="15" y1="72" x2="15" y2="63" style={`stroke:${lastLine ? '#000' : lineColor};stroke-width:2`} />
      <g style={`fill:none;stroke:${lineColor};stroke-width:2`}>
        <line x1="15" y1="0" x2="15" y2="37" />
        <polyline points="15,63 8,51 15,37 22,51 15,63" />
        <line x1="8" y1="50" x2="0" y2="50" />
        <line x1="15" y1="10" x2="30" y2="10" />
      </g>
    </svg>
  );
}

function FplnLineConnectorNormalNotBeforeActiveLeg(lineColor: FplnLineColor, lastLine: boolean): VNode {
  return (
    <svg height="72" width="30">
      <line x1="15" y1="72" x2="15" y2="63" style={`stroke:${lastLine ? '#000' : lineColor};stroke-width:2`} />
      <g style={`fill:none;stroke:${lineColor};stroke-width:2`}>
        <polyline points="15,63 8,51 15,37 22,51 15,63" />
        <line x1="8" y1="50" x2="0" y2="50" />
      </g>
    </svg>
  );
}

function FplnLineConnectorActiveLeg(lineColor: FplnLineColor): VNode {
  return (
    <svg height="72" width="30">
      <line x1="15" y1="72" x2="15" y2="62" style={`stroke:${lineColor};stroke-width:2`} />
      <g style={`fill:none;stroke:${lineColor === FplnLineColor.Active ? '#fff' : lineColor};stroke-width:2`}>
        <line x1="15" y1="9" x2="15" y2="37" />
        <polyline points="15,63 8,51 15,37 22,51 15,63" />
        <line x1="8" y1="50" x2="0" y2="50" />
        <line x1="15" y1="10" x2="30" y2="10" />
      </g>
    </svg>
  );
}

function FplnLineConnectorPseudoWaypoint(lineColor: FplnLineColor, lastLine: boolean): VNode {
  return (
    <svg height="72" width="30">
      <line x1="15" y1="72" x2="15" y2="50" style={`stroke:${lastLine ? '#000' : lineColor};stroke-width:2`} />
      <g style={`fill:none;stroke:${lineColor};stroke-width:2`}>
        <line x1="15" y1="0" x2="15" y2="50" />
        <line x1="15" y1="50" x2="0" y2="50" />
        <line x1="15" y1="10" x2="30" y2="10" />
      </g>
    </svg>
  );
}

function FplnLineConnectorHold(lineColor: FplnLineColor): VNode {
  return (
    <svg height="72" width="30">
      <line x1="15" y1="72" x2="15" y2="0" style={`stroke:${lineColor};stroke-width:2`} />
    </svg>
  );
}