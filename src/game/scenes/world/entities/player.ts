import Phaser from 'phaser';

import { WORLD_DEPTH_EFFECT } from '~const/world';
import { DIFFICULTY } from '~const/world/difficulty';
import {
  PLAYER_TILE_SIZE,
  PLAYER_SKILLS,
  PLAYER_SUPERSKILLS,
  PLAYER_MOVEMENT_KEYS,
  PLAYER_MAX_SKILL_LEVEL,
} from '~const/world/entities/player';
import { LEVEL_TILE_SIZE } from '~const/world/level';
import { Crystal } from '~entity/crystal';
import { Sprite } from '~entity/sprite';
import { Assets } from '~lib/assets';
import { getClosest, isPositionsEqual } from '~lib/dimension';
import { progressionLinear, progressionQuadratic } from '~lib/progression';
import { Tutorial } from '~lib/tutorial';
import { eachEntries } from '~lib/utils';
import { Particles } from '~scene/world/effects';
import { Level } from '~scene/world/level';
import { GameEvents, GameSettings } from '~type/game';
import { NoticeType } from '~type/screen';
import { TutorialStep } from '~type/tutorial';
import { IWorld, WorldEvents, WorldMode } from '~type/world';
import { IParticles, ParticlesTexture } from '~type/world/effects';
import { EntityType } from '~type/world/entities';
import { BuildingVariant } from '~type/world/entities/building';
import { ICrystal } from '~type/world/entities/crystal';
import { IEnemy } from '~type/world/entities/npc/enemy';
import {
  PlayerTexture,
  PlayerAudio,
  PlayerData,
  IPlayer,
  PlayerSkill,
  PlayerSuperskill,
  PlayerSavePayload,
  MovementDirection,
} from '~type/world/entities/player';
import { TileType, Vector2D } from '~type/world/level';
import { WaveEvents } from '~type/world/wave';

Assets.RegisterAudio(PlayerAudio);
Assets.RegisterSprites(PlayerTexture.PLAYER, PLAYER_TILE_SIZE);
Assets.RegisterImages(PlayerTexture.SUPERSKILL);

export class Player extends Sprite implements IPlayer {
  private _experience: number = 0;

  public get experience() { return this._experience; }

  private set experience(v) { this._experience = v; }

  private _resources: number = DIFFICULTY.PLAYER_START_RESOURCES;

  public get resources() { return this._resources; }

  private set resources(v) { this._resources = v; }

  private _score: number = 0;

  public get score() { return this._score; }

  private set score(v) { this._score = v; }

  private _kills: number = 0;

  public get kills() { return this._kills; }

  private set kills(v) { this._kills = v; }

  private _upgradeLevel: Record<PlayerSkill, number> = {
    [PlayerSkill.MAX_HEALTH]: 1,
    [PlayerSkill.SPEED]: 1,
    [PlayerSkill.BUILD_SPEED]: 1,
    [PlayerSkill.ATTACK_DAMAGE]: 1,
    [PlayerSkill.ATTACK_DISTANCE]: 1,
    [PlayerSkill.ATTACK_SPEED]: 1,
  };

  public get upgradeLevel() { return this._upgradeLevel; }

  private set upgradeLevel(v) { this._upgradeLevel = v; }

  private movementTarget: Nullable<number> = null;

  private movementAngle: Nullable<number> = null;

  private dustEffect: Nullable<IParticles> = null;

  private _activeSuperskills: Partial<Record<PlayerSuperskill, boolean>> = {};

  public get activeSuperskills() { return this._activeSuperskills; }

  private set activeSuperskills(v) { this._activeSuperskills = v; }

  private pathToCrystal: Nullable<Phaser.GameObjects.Graphics> = null;

  private pathToCrystalFindingTask: Nullable<string> = null;

  private pathToCrystalEffectIndex: number = 0;

  private pathToCrystalEffectTimestamp: number = 1;

  private currentPathToCrystal: Nullable<Vector2D[]> = null;

  constructor(scene: IWorld, data: PlayerData) {
    super(scene, {
      ...data,
      texture: PlayerTexture.PLAYER,
      health: DIFFICULTY.PLAYER_HEALTH,
      speed: DIFFICULTY.PLAYER_SPEED,
      body: {
        type: 'rect',
        width: 14,
        height: 26,
        gamut: PLAYER_TILE_SIZE.gamut,
      },
    });
    scene.add.existing(this);

    if (this.scene.game.isDesktop()) {
      this.handleMovementByKeyboard();
    }

    this.handleToggleEffects();
    this.handleTogglePathToCrystal();

    this.registerAnimations();

    this.addDustEffect();
    this.addIndicator({
      color: 0xd0ff4f,
      value: () => this.live.health / this.live.maxHealth,
    });

    this.setTilesGroundCollision(true);
    this.setTilesCollision([
      TileType.MAP,
      TileType.BUILDING,
      TileType.CRYSTAL,
    ], (tile) => {
      if (tile instanceof Crystal) {
        tile.pickup();
        this.currentPathToCrystal = null;
      }
    });

    this.addCollider(EntityType.ENEMY, 'collider', (enemy: IEnemy) => {
      enemy.attack(this);
    });

    this.addCollider(EntityType.ENEMY, 'overlap', (enemy: IEnemy) => {
      enemy.overlapTarget();
    });

    this.scene.wave.on(WaveEvents.COMPLETE, this.onWaveComplete.bind(this));
  }

  public update() {
    super.update();

    this.findPathToCrystal();
    this.drawPathToCrystal();

    if (!this.live.isDead()) {
      this.dustEffect?.emitter.setDepth(this.depth - 1);

      this.updateMovement();
      this.updateVelocity();
    }
  }

  public giveScore(amount: number) {
    if (this.live.isDead()) {
      return;
    }

    this.score += amount;
  }

  public giveExperience(amount: number) {
    if (this.live.isDead()) {
      return;
    }

    this.experience += Math.round(amount / this.scene.game.getDifficultyMultiplier());
  }

  public giveResources(amount: number) {
    if (this.live.isDead()) {
      return;
    }

    this.resources += amount;

    if (Tutorial.IsInProgress(TutorialStep.RESOURCES)) {
      Tutorial.Complete(TutorialStep.RESOURCES);
    }
  }

  public takeResources(amount: number) {
    this.resources -= amount;

    if (
      this.resources < DIFFICULTY.BUILDING_GENERATOR_COST
      && this.scene.builder.getBuildingsByVariant(BuildingVariant.GENERATOR).length === 0
    ) {
      Tutorial.Start(TutorialStep.RESOURCES);
    }
  }

  public incrementKills() {
    this.kills++;
  }

  public getSuperskillCost(type: PlayerSuperskill) {
    return progressionLinear({
      defaultValue: PLAYER_SUPERSKILLS[type].cost,
      scale: DIFFICULTY.SUPERSKILL_COST_GROWTH,
      level: this.scene.wave.number,
    });
  }

  public useSuperskill(type: PlayerSuperskill) {
    if (this.activeSuperskills[type] || !this.scene.wave.isGoing) {
      return;
    }

    const cost = this.getSuperskillCost(type);

    if (this.resources < cost) {
      this.scene.game.screen.notice(NoticeType.ERROR, 'NOT_ENOUGH_RESOURCES');

      return;
    }

    this.activeSuperskills[type] = true;

    this.takeResources(cost);

    this.scene.sound.play(PlayerAudio.SUPERSKILL);

    if (this.scene.game.isSettingEnabled(GameSettings.EFFECTS)) {
      const position = this.getPositionOnGround();
      const effect = this.scene.add.image(position.x, position.y, PlayerTexture.SUPERSKILL);

      effect.setDepth(WORLD_DEPTH_EFFECT);

      this.scene.tweens.add({
        targets: effect,
        scale: { from: 0.0, to: 2.0 },
        duration: 500,
        onComplete: () => {
          effect.destroy();
        },
      });
    }

    this.scene.events.emit(WorldEvents.USE_SUPERSKILL, type);

    this.scene.time.addEvent({
      delay: PLAYER_SUPERSKILLS[type].duration,
      callback: () => {
        delete this.activeSuperskills[type];
      },
    });
  }

  public getExperienceToUpgrade(type: PlayerSkill) {
    return progressionQuadratic({
      defaultValue: PLAYER_SKILLS[type].experience,
      scale: DIFFICULTY.PLAYER_EXPERIENCE_TO_UPGRADE_GROWTH,
      level: this.upgradeLevel[type],
      roundTo: 10,
    });
  }

  private getUpgradeNextValue(type: PlayerSkill, level?: number): number {
    const nextLevel = level ?? this.upgradeLevel[type] + 1;

    switch (type) {
      case PlayerSkill.MAX_HEALTH: {
        return progressionQuadratic({
          defaultValue: DIFFICULTY.PLAYER_HEALTH,
          scale: DIFFICULTY.PLAYER_HEALTH_GROWTH,
          level: nextLevel,
          roundTo: 10,
        });
      }
      case PlayerSkill.SPEED: {
        return progressionQuadratic({
          defaultValue: DIFFICULTY.PLAYER_SPEED,
          scale: DIFFICULTY.PLAYER_SPEED_GROWTH,
          level: nextLevel,
        });
      }
      default: {
        return nextLevel;
      }
    }
  }

  public upgrade(type: PlayerSkill) {
    if (this.upgradeLevel[type] === PLAYER_MAX_SKILL_LEVEL) {
      return;
    }

    const experience = this.getExperienceToUpgrade(type);

    if (this.experience < experience) {
      this.scene.game.screen.notice(NoticeType.ERROR, 'NOT_ENOUGH_EXPERIENCE');

      return;
    }

    this.setSkillUpgrade(type, this.upgradeLevel[type] + 1);

    this.experience -= experience;

    this.scene.sound.play(PlayerAudio.UPGRADE);

    Tutorial.Complete(TutorialStep.UPGRADE_SKILL);
  }

  private setSkillUpgrade(type: PlayerSkill, level: number) {
    const nextValue = this.getUpgradeNextValue(type, level);

    switch (type) {
      case PlayerSkill.MAX_HEALTH: {
        const addedHealth = nextValue - this.live.maxHealth;

        this.live.setMaxHealth(nextValue);
        this.live.addHealth(addedHealth);
        break;
      }
      case PlayerSkill.SPEED: {
        this.speed = nextValue;
        if (this.scene.assistant) {
          this.scene.assistant.speed = nextValue;
        }
        break;
      }
    }

    this.upgradeLevel[type] = level;
  }

  public onDamage(amount: number) {
    this.scene.camera.shake();

    const audio = Phaser.Utils.Array.GetRandom([
      PlayerAudio.DAMAGE_1,
      PlayerAudio.DAMAGE_2,
      PlayerAudio.DAMAGE_3,
    ]);

    if (this.scene.game.sound.getAll(audio).length === 0) {
      this.scene.game.sound.play(audio);
    }

    super.onDamage(amount);
  }

  public onDead() {
    this.scene.sound.play(PlayerAudio.DEAD);

    this.setVelocity(0, 0);
    this.stopMovement();

    this.scene.tweens.add({
      targets: [this, this.container],
      alpha: 0.0,
      duration: 250,
    });
  }

  private onWaveComplete(number: number) {
    const experience = progressionQuadratic({
      defaultValue: DIFFICULTY.WAVE_EXPERIENCE,
      scale: DIFFICULTY.WAVE_EXPERIENCE_GROWTH,
      level: number,
    });

    this.giveExperience(experience);
    this.giveScore(number * 10);
    this.live.heal();
  }

  private handleMovementByKeyboard() {
    const activeKeys = new Set<MovementDirection>();

    const toggleKeyState = (key: string, state: boolean) => {
      if (!PLAYER_MOVEMENT_KEYS[key]) {
        return;
      }

      if (state) {
        activeKeys.add(PLAYER_MOVEMENT_KEYS[key]);
      } else {
        activeKeys.delete(PLAYER_MOVEMENT_KEYS[key]);
      }

      if (activeKeys.has(MovementDirection.DOWN)) {
        if (activeKeys.has(MovementDirection.LEFT)) {
          this.movementTarget = 3;
        } else if (activeKeys.has(MovementDirection.RIGHT)) {
          this.movementTarget = 1;
        } else {
          this.movementTarget = 2;
        }
      } else if (activeKeys.has(MovementDirection.UP)) {
        if (activeKeys.has(MovementDirection.LEFT)) {
          this.movementTarget = 5;
        } else if (activeKeys.has(MovementDirection.RIGHT)) {
          this.movementTarget = 7;
        } else {
          this.movementTarget = 6;
        }
      } else if (activeKeys.has(MovementDirection.LEFT)) {
        this.movementTarget = 4;
      } else if (activeKeys.has(MovementDirection.RIGHT)) {
        this.movementTarget = 0;
      } else {
        this.movementTarget = null;
      }
    };

    this.scene.input.keyboard?.on(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, (event: KeyboardEvent) => {
      toggleKeyState(event.code, true);
    });

    this.scene.input.keyboard?.on(Phaser.Input.Keyboard.Events.ANY_KEY_UP, (event: KeyboardEvent) => {
      toggleKeyState(event.code, false);
    });
  }

  private updateVelocity() {
    if (this.movementAngle === null) {
      this.setVelocity(0, 0);
    } else {
      const collide = this.handleCollide(this.movementAngle);

      if (collide) {
        this.setVelocity(0, 0);
      } else {
        const friction = this.currentBiome?.friction ?? 1;
        const speed = this.speed / friction;
        const velocity = this.scene.physics.velocityFromAngle(this.movementAngle, speed);

        this.setVelocity(
          velocity.x,
          velocity.y * LEVEL_TILE_SIZE.persperctive,
        );
      }
    }
  }

  private updateMovement() {
    if (this.movementTarget === null) {
      this.stopMovement();
    } else if (this.movementAngle === null) {
      this.startMovement();
    } else {
      this.setMovementAngle();
    }
  }

  private startMovement() {
    if (this.movementTarget === null) {
      return;
    }

    this.setMovementAngle();

    this.dustEffect?.emitter.start();

    this.scene.game.sound.play(PlayerAudio.WALK, {
      loop: true,
      rate: 1.8,
    });
  }

  public setMovementTarget(angle: Nullable<number>) {
    this.movementTarget = angle === null ? null : Math.round(angle / 45) % 8;
  }

  private setMovementAngle() {
    if (
      this.movementTarget === null
      || this.movementAngle === this.movementTarget * 45
    ) {
      return;
    }

    this.movementAngle = this.movementTarget * 45;
    this.anims.play({
      key: `dir_${this.movementTarget}`,
      startFrame: 1,
    });
  }

  private stopMovement() {
    if (this.movementAngle === null) {
      return;
    }

    this.movementAngle = null;

    if (this.anims.currentAnim) {
      this.anims.setProgress(0);
      this.anims.stop();
    }

    this.dustEffect?.emitter.stop();

    this.scene.sound.stopByKey(PlayerAudio.WALK);
  }

  private addDustEffect() {
    if (
      this.dustEffect
      || !this.scene.game.isSettingEnabled(GameSettings.EFFECTS)
    ) {
      return;
    }

    this.dustEffect = new Particles(this, {
      key: 'dust',
      texture: ParticlesTexture.BIT,
      params: {
        follow: this,
        followOffset: {
          x: 0,
          y: -this.gamut * this.scaleY * 0.5,
        },
        lifespan: { min: 150, max: 300 },
        scale: 0.6,
        speed: 10,
        frequency: 150,
        alpha: { start: 0.75, end: 0.0 },
        emitting: false,
      },
    });
  }

  private removeDustEffect() {
    if (!this.dustEffect) {
      return;
    }

    this.dustEffect.destroy();
    this.dustEffect = null;
  }

  private addPathToCrystal() {
    if (this.pathToCrystal) {
      return;
    }

    this.pathToCrystal = this.scene.add.graphics();
    this.pathToCrystal.setDepth(WORLD_DEPTH_EFFECT);
  }

  private removePathToCrystal() {
    if (!this.pathToCrystal) {
      return;
    }

    this.pathToCrystal.destroy();
    this.pathToCrystal = null;
  }

  private drawPathToCrystal() {
    if (!this.pathToCrystal) {
      return;
    }

    this.pathToCrystal.clear();

    if (!this.currentPathToCrystal) {
      return;
    }

    const now = Date.now();
    const path = [...this.currentPathToCrystal];
    const halfVisibleLength = 4;

    if (this.pathToCrystalEffectTimestamp <= now) {
      this.pathToCrystalEffectIndex++;
      this.pathToCrystalEffectTimestamp = now + (1000 / path.length);
    }
    if (this.pathToCrystalEffectIndex >= path.length) {
      this.pathToCrystalEffectIndex = 0;
    }

    for (let i = -halfVisibleLength; i <= halfVisibleLength; i++) {
      const ri = this.pathToCrystalEffectIndex + i;

      if (ri > 1 && ri < path.length) {
        const prev = Level.ToWorldPosition({ ...path[ri - 1], z: 0 });
        const next = Level.ToWorldPosition({ ...path[ri], z: 0 });
        const alpha = 1.0 - Math.min(Math.abs(i / halfVisibleLength), 0.9);

        this.pathToCrystal.lineStyle(2, 0xffffff, alpha);
        this.pathToCrystal.lineBetween(prev.x, prev.y, next.x, next.y);
      }
    }
  }

  private findPathToCrystal() {
    if (
      !this.pathToCrystal
      || this.pathToCrystalFindingTask
      || (
        this.currentPathToCrystal?.[0]
        && isPositionsEqual(this.currentPathToCrystal[0], this.scene.player.positionAtMatrix)
      )
    ) {
      return;
    }

    const crystals = this.scene.getEntities<ICrystal>(EntityType.CRYSTAL);
    const crystal = getClosest(crystals, this);

    if (!crystal) {
      return;
    }

    this.pathToCrystalFindingTask = this.scene.level.navigator.createTask({
      from: this.scene.player.positionAtMatrix,
      to: crystal.positionAtMatrix,
      grid: this.scene.level.gridSolid,
    }, (path: Nullable<Vector2D[]>) => {
      this.currentPathToCrystal = (path && path.length > 2) ? path : null;
      this.pathToCrystalFindingTask = null;
    });
  }

  private registerAnimations() {
    Array.from({ length: 8 }).forEach((_, index) => {
      this.anims.create({
        key: `dir_${index}`,
        frames: this.anims.generateFrameNumbers(PlayerTexture.PLAYER, {
          start: index * 4,
          end: (index + 1) * 4 - 1,
        }),
        frameRate: 8,
        repeat: -1,
      });
    });
  }

  private handleToggleEffects() {
    const handler = (enabled: boolean) => {
      if (enabled) {
        this.addDustEffect();
      } else {
        this.removeDustEffect();
      }
    };

    this.scene.game.events.on(`${GameEvents.UPDATE_SETTINGS}.${GameSettings.EFFECTS}`, handler);

    this.on(Phaser.GameObjects.Events.DESTROY, () => {
      this.scene.game.events.off(`${GameEvents.UPDATE_SETTINGS}.${GameSettings.EFFECTS}`, handler);
    });
  }

  private handleTogglePathToCrystal() {
    const handler = (mode: WorldMode, state: boolean) => {
      switch (mode) {
        case WorldMode.PATH_TO_CRYSTAL: {
          if (state) {
            this.addPathToCrystal();
          } else {
            this.removePathToCrystal();
          }
          break;
        }
      }
    };

    this.scene.events.on(WorldEvents.TOGGLE_MODE, handler);

    this.on(Phaser.GameObjects.Events.DESTROY, () => {
      this.scene.events.off(WorldEvents.TOGGLE_MODE, handler);
    });
  }

  public getSavePayload(): PlayerSavePayload {
    return {
      position: this.positionAtMatrix,
      score: this.score,
      experience: this.experience,
      resources: this.resources,
      kills: this.kills,
      health: this.live.health,
      upgradeLevel: this.upgradeLevel,
    };
  }

  public loadSavePayload(data: PlayerSavePayload) {
    this.score = data.score;
    this.experience = data.experience;
    this.resources = data.resources;
    this.kills = data.kills;

    eachEntries(data.upgradeLevel, (type, level) => {
      if (level > 1) {
        this.setSkillUpgrade(type, level);
      }
    });

    this.live.setHealth(data.health);
  }
}
