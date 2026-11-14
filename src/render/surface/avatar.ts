import * as THREE from 'three';
import { hex, MeshBuilder, shade, type RGB } from './models';

/**
 * The player's body: a low-poly traveller with a walk cycle. Local frame +Y up,
 * +Z forward, feet at the origin; the explorer places and orients it.
 */
export class Avatar {
  readonly root = new THREE.Group();
  private readonly legL: THREE.Object3D;
  private readonly legR: THREE.Object3D;
  private readonly armL: THREE.Object3D;
  private readonly armR: THREE.Object3D;
  private readonly body: THREE.Object3D;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private phase = 0;

  constructor() {
    const cloak = hex('#7a4a2e');
    const trousers = hex('#3f4656');
    const skin = hex('#e2b48a');
    const hair = hex('#3a2a1c');
    const pack = hex('#6b5a3a');

    this.body = this.part((b) => {
      b.box(0, 1.2, 0, 0.42, 0.62, 0.26, cloak);
      b.box(0, 0.86, 0, 0.44, 0.12, 0.28, shade(cloak, 0.7));
      b.box(0, 1.22, -0.2, 0.34, 0.44, 0.16, pack);
      b.box(0, 1.58, 0, 0.14, 0.1, 0.14, skin);
      b.blob(0, 1.77, 0.01, 0.15, 0.17, 0.15, skin, () => 0.5, 0);
      b.box(0, 1.88, -0.02, 0.32, 0.06, 0.34, hair);
      b.box(0, 1.94, -0.02, 0.2, 0.1, 0.22, hair);
      b.box(0.05, 1.78, 0.14, 0.035, 0.035, 0.02, hex('#222222'));
      b.box(-0.05, 1.78, 0.14, 0.035, 0.035, 0.02, hex('#222222'));
    });
    this.root.add(this.body);
    this.legL = this.limb(0.11, 0.86, (b) => b.box(0, -0.42, 0, 0.15, 0.84, 0.17, trousers), shade(trousers, 0.6));
    this.legR = this.limb(-0.11, 0.86, (b) => b.box(0, -0.42, 0, 0.15, 0.84, 0.17, trousers), shade(trousers, 0.6));
    this.armL = this.limb(0.27, 1.46, (b) => b.box(0, -0.3, 0, 0.11, 0.6, 0.12, cloak), skin);
    this.armR = this.limb(-0.27, 1.46, (b) => b.box(0, -0.3, 0, 0.11, 0.6, 0.12, cloak), skin);
  }

  private part(fn: (b: MeshBuilder) => void): THREE.Mesh {
    const b = new MeshBuilder();
    fn(b);
    const t = b.build();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(t.col, 3));
    return new THREE.Mesh(g, this.material);
  }

  /** A limb hanging from a joint at (x, y); `end` colours the hand or boot. */
  private limb(x: number, y: number, fn: (b: MeshBuilder) => void, end: RGB): THREE.Object3D {
    const joint = new THREE.Group();
    joint.position.set(x, y, 0);
    const len = y > 1.2 ? 0.6 : 0.84;
    joint.add(this.part((b) => {
      fn(b);
      b.box(0, -len - 0.04, y > 1.2 ? 0 : 0.04, 0.12, 0.09, y > 1.2 ? 0.11 : 0.24, end);
    }));
    this.root.add(joint);
    return joint;
  }

  /** speed in m/s; swimming hides the legs' swing and bobs the body. */
  animate(dt: number, speed: number, airborne: boolean, swimming: boolean): void {
    const stride = 1.35;
    this.phase += (dt * speed * Math.PI) / stride;
    const amp = airborne ? 0.5 : Math.min(0.85, speed * 0.12);
    const s = Math.sin(this.phase);
    this.legL.rotation.x = s * amp;
    this.legR.rotation.x = -s * amp;
    this.armL.rotation.x = -s * amp * 0.8;
    this.armR.rotation.x = s * amp * 0.8;
    this.body.position.y = swimming ? 0 : Math.abs(Math.cos(this.phase)) * amp * 0.06;
    if (swimming) {
      this.armL.rotation.z = 0.9 + s * 0.4;
      this.armR.rotation.z = -0.9 - s * 0.4;
    } else {
      this.armL.rotation.z = 0.05;
      this.armR.rotation.z = -0.05;
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.material.dispose();
  }
}
