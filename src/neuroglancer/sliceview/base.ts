/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {partitionArray} from 'neuroglancer/util/array';
import {approxEqual} from 'neuroglancer/util/compare';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {kAxes, kIdentityQuat, kInfinityVec, kZeroVec, Mat4, mat4, prod3, Quat, rectifyTransformMatrixIfAxisAligned, Vec3, vec3, vec4} from 'neuroglancer/util/geom';
import {SharedObject} from 'neuroglancer/worker_rpc';

export {DATA_TYPE_BYTES, DataType};

const DEBUG_CHUNK_INTERSECTIONS = false;
const DEBUG_VISIBLE_SOURCES = false;

const tempVec3 = vec3.create();

/**
 * Average cross-sectional area contained within a chunk of the specified size and rotation.
 *
 * This is estimated by taking the total volume of the chunk and dividing it by the total length of
 * the chunk along the z axis.
 */
function estimateSliceAreaPerChunk(zAxis: Vec3, chunkLayout: ChunkLayout) {
  const chunkSize = chunkLayout.size;
  const zAxisRotated = chunkLayout.globalToLocalSpatialVector(tempVec3, zAxis);

  // Minimum and maximum dot product of zAxisRotated with each of the corners of the chunk.  Both
  // are initialized to 0 because the origin of the chunk has a projection of 0.
  let minProjection = 0, maxProjection = 0;
  let chunkVolume = 1;
  for (let i = 0; i < 3; ++i) {
    const chunkSizeValue = chunkSize[i];
    chunkVolume *= chunkSizeValue;
    const projection = chunkSizeValue * zAxisRotated[i];
    minProjection = Math.min(minProjection, projection);
    maxProjection = Math.max(maxProjection, projection);
  }
  const projectionLength = maxProjection - minProjection;
  return chunkVolume / projectionLength;
}

/**
 * All valid chunks are in the range [lowerBound, upperBound).
 *
 * @param lowerBound Output parameter for lowerBound.
 * @param upperBound Output parameter for upperBound.
 * @param sources Sources for which to compute the chunk bounds.
 */
function computeSourcesChunkBounds(
    sourcesLowerBound: Vec3, sourcesUpperBound: Vec3, sources: Iterable<VolumeChunkSource>) {
  for (let i = 0; i < 3; ++i) {
    sourcesLowerBound[i] = Number.POSITIVE_INFINITY;
    sourcesUpperBound[i] = Number.NEGATIVE_INFINITY;
  }

  for (let source of sources) {
    let {spec} = source;
    let {lowerChunkBound, upperChunkBound} = spec;
    for (let i = 0; i < 3; ++i) {
      sourcesLowerBound[i] = Math.min(sourcesLowerBound[i], lowerChunkBound[i]);
      sourcesUpperBound[i] = Math.max(sourcesUpperBound[i], upperChunkBound[i]);
    }
  }
}

enum BoundsComparisonResult {
  // Needle is fully outside haystack.
  FULLY_OUTSIDE,
  // Needle is fully inside haystack.
  FULLY_INSIDE,
  // Needle is partially inside haystack.
  PARTIALLY_INSIDE
}

function compareBoundsSingleDimension(
    needleLower: number, needleUpper: number, haystackLower: number, haystackUpper: number) {
  if (needleLower >= haystackUpper || needleUpper <= haystackLower) {
    return BoundsComparisonResult.FULLY_OUTSIDE;
  }
  if (needleLower >= haystackLower && needleUpper <= haystackUpper) {
    return BoundsComparisonResult.FULLY_INSIDE;
  }
  return BoundsComparisonResult.PARTIALLY_INSIDE;
}

function compareBounds(
    needleLowerBound: Vec3, needleUpperBound: Vec3, haystackLowerBound: Vec3,
    haystackUpperBound: Vec3) {
  let curResult = BoundsComparisonResult.FULLY_INSIDE;
  for (let i = 0; i < 3; ++i) {
    let newResult = compareBoundsSingleDimension(
        needleLowerBound[i], needleUpperBound[i], haystackLowerBound[i], haystackUpperBound[i]);
    switch (newResult) {
      case BoundsComparisonResult.FULLY_OUTSIDE:
        return newResult;
      case BoundsComparisonResult.PARTIALLY_INSIDE:
        curResult = newResult;
        break;
    }
  }
  return curResult;
}

export interface RenderLayer { sources: VolumeChunkSource[][]|null; }

function pickBestAlternativeSource(zAxis: Vec3, alternatives: VolumeChunkSource[]) {
  let numAlternatives = alternatives.length;
  let bestAlternativeIndex = 0;
  if (DEBUG_VISIBLE_SOURCES) {
    console.log(alternatives);
  }
  if (numAlternatives > 1) {
    let bestSliceArea = 0;
    for (let alternativeIndex = 0; alternativeIndex < numAlternatives; ++alternativeIndex) {
      let alternative = alternatives[alternativeIndex];
      let {chunkLayout} = alternative.spec;
      let sliceArea = estimateSliceAreaPerChunk(zAxis, chunkLayout);
      if (DEBUG_VISIBLE_SOURCES) {
        console.log(
            `zAxis = ${zAxis}, chunksize = ${alternative.spec.chunkLayout.size}, sliceArea = ${sliceArea}`);
      }
      if (sliceArea > bestSliceArea) {
        bestSliceArea = sliceArea;
        bestAlternativeIndex = alternativeIndex;
      }
    }
  }
  return alternatives[bestAlternativeIndex];
}

const tempCorners = [vec3.create(), vec3.create(), vec3.create(), vec3.create()];

export class SliceViewBase extends SharedObject {
  width = -1;
  height = -1;
  hasViewportToData = false;
  /**
   * Specifies whether width, height, and viewportToData are valid.
   */
  hasValidViewport = false;

  // Transforms (x,y) viewport coordinates in the range:
  //
  // x=[left: -width/2, right: width/2] and
  //
  // y=[top: -height/2, bottom: height/2],
  //
  // to data coordinates.
  viewportToData = mat4.create();

  // Normalized x, y, and z viewport axes in data coordinate space.
  viewportAxes = [vec4.create(), vec4.create(), vec4.create()];

  // Viewport axes used for selecting visible sources.
  previousViewportAxes = [vec3.create(), vec3.create()];

  centerDataPosition = vec3.create();

  viewportPlaneDistanceToOrigin: number = 0;

  /**
   * For each visible ChunkLayout, maps each visible VolumeChunkSource to its priority index.
   */
  visibleChunkLayouts = new Map<ChunkLayout, Map<VolumeChunkSource, number>>();

  visibleLayers = new Map<RenderLayer, VolumeChunkSource[]>();

  visibleSourcesStale = true;

  pixelSize: number = 0;

  constructor() {
    super();
    mat4.identity(this.viewportToData);
  }

  /**
   * Called when hasValidViewport == true and the viewport width/height or data transform matrix
   * changes.
   */
  onViewportChanged() {}
  maybeSetHasValidViewport() {
    if (!this.hasValidViewport && this.width !== -1 && this.height !== -1 &&
        this.hasViewportToData) {
      this.hasValidViewport = true;
      this.onHasValidViewport();
    }
    if (this.hasValidViewport) {
      this.onViewportChanged();
    }
  }
  onHasValidViewport() {}
  setViewportSize(width: number, height: number) {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.maybeSetHasValidViewport();
      return true;
    }
    return false;
  }
  setViewportToDataMatrix(mat: Mat4) {
    if (this.hasViewportToData && mat4.equals(this.viewportToData, mat)) {
      return false;
    }

    this.hasViewportToData = true;

    let {viewportToData} = this;
    mat4.copy(viewportToData, mat);
    rectifyTransformMatrixIfAxisAligned(viewportToData);
    vec3.transformMat4(this.centerDataPosition, kZeroVec, mat);

    // Initialize to zero to avoid confusing TypeScript compiler.
    let newPixelSize = 0;

    // Swap previousViewportAxes with viewportAxes.
    let viewportAxes = this.viewportAxes;
    let previousViewportAxes = this.previousViewportAxes;

    // Compute axes.
    for (var i = 0; i < 3; ++i) {
      let a = viewportAxes[i];
      vec4.transformMat4(a, kAxes[i], viewportToData);
      // a[3] is guaranteed to be 0.
      if (i === 0) {
        newPixelSize = vec3.length(a);
      }
      vec4.normalize(a, a);
    }

    this.viewportAxes = viewportAxes;
    this.previousViewportAxes = previousViewportAxes;

    if (!approxEqual(newPixelSize, this.pixelSize) ||
        (vec3.dot(viewportAxes[0], previousViewportAxes[0]) < 0.95) ||
        (vec3.dot(viewportAxes[1], previousViewportAxes[1]) < 0.95)) {
      vec3.copy(previousViewportAxes[0], viewportAxes[0]);
      vec3.copy(previousViewportAxes[1], viewportAxes[1]);
      this.visibleSourcesStale = true;
      this.pixelSize = newPixelSize;
    }

    // Compute viewport plane distance to origin.
    this.viewportPlaneDistanceToOrigin = vec3.dot(this.centerDataPosition, this.viewportAxes[2]);
    this.onViewportToDataMatrixChanged();
    this.maybeSetHasValidViewport();
    return true;
  }

  onViewportToDataMatrixChanged() {}

  /**
   * Computes the list of sources to use for each visible layer, based on the
   * current pixelSize.
   */
  updateVisibleSources() {
    if (!this.visibleSourcesStale) {
      return;
    }
    this.visibleSourcesStale = false;
    // Increase pixel size by a small margin.
    let pixelSize = this.pixelSize * 1.1;
    // console.log("pixelSize", pixelSize);

    let visibleChunkLayouts = this.visibleChunkLayouts;
    const zAxis = this.viewportAxes[2];

    let visibleLayers = this.visibleLayers;
    visibleChunkLayouts.clear();
    for (let [renderLayer, visibleSources] of visibleLayers) {
      visibleSources.length = 0;
      let sources = renderLayer.sources!;
      let numSources = sources.length;
      let scaleIndex: number;

      // At the smallest scale, all alternative sources must have the same voxel size, which is
      // considered to be the base voxel size.
      let smallestVoxelSize = sources[0][0].spec.voxelSize;

      /**
       * Determines whether we should continue to look for a finer-resolution source *after* one
       * with the specified voxelSize.
       */
      const canImproveOnVoxelSize = (voxelSize: Vec3) => {
        for (let i = 0; i < 3; ++i) {
          let size = voxelSize[i];
          // If size <= pixelSize, no need for improvement.
          // If size === smallestVoxelSize, also no need for improvement.
          if (size > pixelSize && size > smallestVoxelSize[i]) {
            return true;
          }
        }
        return false;
      };

      /**
       * Registers a source as being visible.  This should be called with consecutively decreasing
       * values of scaleIndex.
       */
      const addVisibleSource = (source: VolumeChunkSource, scaleIndex: number) => {
        // Add to end of visibleSources list.  We will reverse the list after all sources are added.
        visibleSources[visibleSources.length++] = source;
        let chunkLayout = source.spec.chunkLayout;
        let existingSources = visibleChunkLayouts.get(chunkLayout);
        if (existingSources === undefined) {
          existingSources = new Map<VolumeChunkSource, number>();
          visibleChunkLayouts.set(chunkLayout, existingSources);
        }
        existingSources.set(source, numSources - scaleIndex - 1);
      };

      scaleIndex = numSources - 1;
      while (true) {
        let source = pickBestAlternativeSource(zAxis, sources[scaleIndex]);
        addVisibleSource(source, scaleIndex);
        if (scaleIndex === 0 || !canImproveOnVoxelSize(source.spec.voxelSize)) {
          break;
        }
        --scaleIndex;
      }
      // Reverse visibleSources list since we added sources from coarsest to finest resolution, but
      // we want them ordered from finest to coarsest.
      visibleSources.reverse();
    }
  }
  computeVisibleChunks<T>(
      getLayoutObject: (chunkLayout: ChunkLayout) => T,
      addChunk:
          (chunkLayout: ChunkLayout, layoutObject: T, lowerBound: Vec3,
           fullyVisibleSources: VolumeChunkSource[]) => void) {
    this.updateVisibleSources();

    // Lower and upper bound in global data coordinates.
    const globalCorners = tempCorners;
    let {width, height, viewportToData} = this;
    for (let i = 0; i < 3; ++i) {
      globalCorners[0][i] = -kAxes[0][i] * width / 2 - kAxes[1][i] * height / 2;
      globalCorners[1][i] = -kAxes[0][i] * width / 2 + kAxes[1][i] * height / 2;
      globalCorners[2][i] = kAxes[0][i] * width / 2 - kAxes[1][i] * height / 2;
      globalCorners[3][i] = kAxes[0][i] * width / 2 + kAxes[1][i] * height / 2;
    }
    for (let i = 0; i < 4; ++i) {
      vec3.transformMat4(globalCorners[i], globalCorners[i], viewportToData);
    }
    // console.log("data bounds", dataLowerBound, dataUpperBound);

    // These variables hold the lower and upper bounds on chunk grid positions that intersect the
    // viewing plane.
    var lowerChunkBound = vec3.create();
    var upperChunkBound = vec3.create();

    let sourcesLowerChunkBound = vec3.create();
    let sourcesUpperChunkBound = vec3.create();

    // Vertex with maximal dot product with the positive viewport plane normal.
    // Implicitly, negativeVertex = 1 - positiveVertex.
    var positiveVertex = vec3.create();

    var planeNormal = vec3.create();

    // Sources whose bounds partially contain the current bounding box.
    let partiallyVisibleSources = new Array<VolumeChunkSource>();

    // Sources whose bounds fully contain the current bounding box.
    let fullyVisibleSources = new Array<VolumeChunkSource>();

    this.visibleChunkLayouts.forEach((visibleSources, chunkLayout) => {
      let layoutObject = getLayoutObject(chunkLayout);
      computeSourcesChunkBounds(
          sourcesLowerChunkBound, sourcesUpperChunkBound, visibleSources.keys());
      if (DEBUG_CHUNK_INTERSECTIONS) {
        console.log(
            `Initial sources chunk bounds: ${vec3.str(sourcesLowerChunkBound)}, ${vec3.str(sourcesUpperChunkBound)}`);
      }

      vec3.set(
          lowerChunkBound, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY);
      vec3.set(
          upperChunkBound, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY);

      chunkLayout.globalToLocalSpatialVector(planeNormal, this.viewportAxes[2]);
      for (let i = 0; i < 3; ++i) {
        positiveVertex[i] = planeNormal[i] > 0 ? 1 : 0;
      }

      // Center position in chunk grid coordinates.
      const planeDistanceToOrigin =
          vec3.dot(chunkLayout.globalToLocalGrid(tempVec3, this.centerDataPosition), planeNormal);

      for (let i = 0; i < 4; ++i) {
        const localCorner = chunkLayout.globalToLocalGrid(tempVec3, globalCorners[i]);
        for (let j = 0; j < 3; ++j) {
          lowerChunkBound[j] = Math.min(lowerChunkBound[j], Math.floor(localCorner[j]));
          upperChunkBound[j] = Math.max(upperChunkBound[j], Math.floor(localCorner[j]) + 1);
        }
      }
      vec3.max(lowerChunkBound, lowerChunkBound, sourcesLowerChunkBound);
      vec3.min(upperChunkBound, upperChunkBound, sourcesUpperChunkBound);

      // console.log('chunkBounds', lowerBound, upperBound);

      // Checks whether [lowerBound, upperBound) intersects the viewport plane.
      //
      // positiveVertexDistanceToOrigin = dot(planeNormal, lowerBound +
      // positiveVertex * (upperBound - lowerBound)) - planeDistanceToOrigin;
      // negativeVertexDistanceToOrigin = dot(planeNormal, lowerBound +
      // negativeVertex * (upperBound - lowerBound)) - planeDistanceToOrigin;
      //
      // positive vertex must have positive distance, and negative vertex must
      // have negative distance.
      function intersectsPlane() {
        var positiveVertexDistanceToOrigin = 0;
        var negativeVertexDistanceToOrigin = 0;
        // Check positive vertex.
        for (let i = 0; i < 3; ++i) {
          let normalValue = planeNormal[i];
          let lowerValue = lowerChunkBound[i];
          let upperValue = upperChunkBound[i];
          let diff = upperValue - lowerValue;
          let positiveOffset = positiveVertex[i] * diff;
          // console.log(
          //     normalValue, lowerValue, upperValue, diff, positiveOffset,
          //     positiveVertexDistanceToOrigin, negativeVertexDistanceToOrigin);
          positiveVertexDistanceToOrigin += normalValue * (lowerValue + positiveOffset);
          negativeVertexDistanceToOrigin += normalValue * (lowerValue + diff - positiveOffset);
        }
        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(`    planeNormal = ${planeNormal}`);
          console.log(
              '    {positive,negative}VertexDistanceToOrigin: ', positiveVertexDistanceToOrigin,
              negativeVertexDistanceToOrigin, planeDistanceToOrigin);
          console.log(
              '    intersectsPlane:', negativeVertexDistanceToOrigin, planeDistanceToOrigin,
              positiveVertexDistanceToOrigin);
        }
        if (positiveVertexDistanceToOrigin < planeDistanceToOrigin) {
          return false;
        }

        return negativeVertexDistanceToOrigin <= planeDistanceToOrigin;
      }

      fullyVisibleSources.length = 0;
      partiallyVisibleSources.length = 0;
      for (let source of visibleSources.keys()) {
        let spec = source.spec;
        let result = compareBounds(
            lowerChunkBound, upperChunkBound, spec.lowerChunkBound, spec.upperChunkBound);
        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(
              `Comparing source bounds lowerBound=${vec3.str(lowerChunkBound)}, upperBound=${vec3.str(upperChunkBound)}, lowerChunkBound=${vec3.str(spec.lowerChunkBound)}, upperChunkBound=${vec3.str(spec.upperChunkBound)}, got ${BoundsComparisonResult[result]}`,
              spec, source);
        }
        switch (result) {
          case BoundsComparisonResult.FULLY_INSIDE:
            fullyVisibleSources.push(source);
            break;
          case BoundsComparisonResult.PARTIALLY_INSIDE:
            partiallyVisibleSources.push(source);
            break;
        }
      }
      let partiallyVisibleSourcesLength = partiallyVisibleSources.length;

      // Mutates lowerBound and upperBound while running, but leaves them the
      // same once finished.
      function checkBounds(nextSplitDim: number) {
        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(
              `chunk bounds: ${lowerChunkBound} ${upperChunkBound} fullyVisible: ${fullyVisibleSources} partiallyVisible: ${partiallyVisibleSources.slice(0, partiallyVisibleSourcesLength)}`);
        }

        if (fullyVisibleSources.length === 0 && partiallyVisibleSourcesLength === 0) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  no visible sources');
          }
          return;
        }

        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(
              `Check bounds: [ ${vec3.str(lowerChunkBound)}, ${vec3.str(upperChunkBound)} ]`);
        }
        var volume = 1;
        for (let i = 0; i < 3; ++i) {
          volume *= Math.max(0, upperChunkBound[i] - lowerChunkBound[i]);
        }

        if (volume === 0) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  volume == 0');
          }
          return;
        }

        if (!intersectsPlane()) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  doesn\'t intersect plane');
          }
          return;
        }

        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(
              'Within bounds: [' + vec3.str(lowerChunkBound) + ', ' + vec3.str(upperChunkBound) +
              ']');
        }

        if (volume === 1) {
          addChunk(chunkLayout, layoutObject, lowerChunkBound, fullyVisibleSources);
          return;
        }

        var dimLower: number, dimUpper: number, diff: number;
        while (true) {
          dimLower = lowerChunkBound[nextSplitDim];
          dimUpper = upperChunkBound[nextSplitDim];
          diff = dimUpper - dimLower;
          if (diff === 1) {
            nextSplitDim = (nextSplitDim + 1) % 3;
          } else {
            break;
          }
        }

        let splitPoint = dimLower + Math.floor(0.5 * diff);
        let newNextSplitDim = (nextSplitDim + 1) % 3;
        let fullyVisibleSourcesLength = fullyVisibleSources.length;

        upperChunkBound[nextSplitDim] = splitPoint;

        let oldPartiallyVisibleSourcesLength = partiallyVisibleSourcesLength;
        function adjustSources() {
          partiallyVisibleSourcesLength = partitionArray(
              partiallyVisibleSources, 0, oldPartiallyVisibleSourcesLength, source => {
                let spec = source.spec;
                let result = compareBounds(
                    lowerChunkBound, upperChunkBound, spec.lowerChunkBound, spec.upperChunkBound);
                switch (result) {
                  case BoundsComparisonResult.PARTIALLY_INSIDE:
                    return true;
                  case BoundsComparisonResult.FULLY_INSIDE:
                    fullyVisibleSources.push(source);
                  default:
                    return false;
                }
              });
        }

        adjustSources();
        checkBounds(newNextSplitDim);

        // Truncate list of fully visible sources.
        fullyVisibleSources.length = fullyVisibleSourcesLength;

        // Restore partiallyVisibleSources.
        partiallyVisibleSourcesLength = oldPartiallyVisibleSourcesLength;

        upperChunkBound[nextSplitDim] = dimUpper;
        lowerChunkBound[nextSplitDim] = splitPoint;

        adjustSources();
        checkBounds(newNextSplitDim);

        lowerChunkBound[nextSplitDim] = dimLower;

        // Truncate list of fully visible sources.
        fullyVisibleSources.length = fullyVisibleSourcesLength;

        // Restore partiallyVisibleSources.
        partiallyVisibleSourcesLength = oldPartiallyVisibleSourcesLength;
      }
      checkBounds(0);
    });
  }
};

/**
 * Specifies the interpretation of volumetric data.
 */
export enum VolumeType {
  UNKNOWN,
  IMAGE,
  SEGMENTATION,
}

/**
 * By default, choose a chunk size with at most 2^18 = 262144 voxels.
 */
export const DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2 = 18;

/**
 * Determines a near-isotropic (in nanometers) block size.  All dimensions will be powers of 2, and
 * will not exceed upperVoxelBound - lowerVoxelBound.  The total number of voxels will not exceed
 * maxVoxelsPerChunkLog2.
 */
export function getNearIsotropicBlockSize(options: {
  voxelSize: Vec3,
  lowerVoxelBound?: Vec3,
  upperVoxelBound?: Vec3,
  maxVoxelsPerChunkLog2?: number
}) {
  let {voxelSize, lowerVoxelBound = kZeroVec, upperVoxelBound,
       maxVoxelsPerChunkLog2 = DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2} = options;

  let chunkDataSize = vec3.fromValues(1, 1, 1);
  let maxChunkDataSize: Vec3;
  if (upperVoxelBound === undefined) {
    maxChunkDataSize = kInfinityVec;
  } else {
    maxChunkDataSize = vec3.create();
    for (let i = 0; i < 3; ++i) {
      maxChunkDataSize[i] =
          Math.pow(2, Math.floor(Math.log2(upperVoxelBound[i] - lowerVoxelBound[i])));
    }
  }

  // Determine the dimension in which chunkDataSize should be increased.  This is the smallest
  // dimension (in nanometers) that is < maxChunkDataSize (in voxels).
  //
  // Returns -1 if there is no such dimension.
  function findNextDimension() {
    let minSize = Infinity;
    let minDimension = -1;
    for (let i = 0; i < 3; ++i) {
      if (chunkDataSize[i] >= maxChunkDataSize[i]) {
        continue;
      }
      let size = chunkDataSize[i] * voxelSize[i];
      if (size < minSize) {
        minSize = size;
        minDimension = i;
      }
    }
    return minDimension;
  }

  for (let i = 0; i < maxVoxelsPerChunkLog2; ++i) {
    let nextDim = findNextDimension();
    if (nextDim === -1) {
      break;
    }
    chunkDataSize[nextDim] *= 2;
  }
  return chunkDataSize;
}

/**
 * Computes a 3-d block size that has depth 1 in flatDimension and is near-isotropic (in nanometers)
 * in the other two dimensions.  The remaining options are the same as for
 * getNearIsotropicBlockSize.
 */
export function getTwoDimensionalBlockSize(options: {
  flatDimension: number,
  voxelSize: Vec3, lowerVoxelBound?: Vec3, upperVoxelBound?: Vec3, maxVoxelsPerChunkLog2?: number
}) {
  let {lowerVoxelBound = kZeroVec, upperVoxelBound = kInfinityVec, flatDimension, voxelSize,
       maxVoxelsPerChunkLog2} = options;
  vec3.subtract(tempVec3, upperVoxelBound, lowerVoxelBound);
  tempVec3[flatDimension] = 1;
  return getNearIsotropicBlockSize({voxelSize, upperVoxelBound: tempVec3, maxVoxelsPerChunkLog2});
}

/**
 * Common parameters for the VolumeChunkSpecification constructor and
 * VolumeChunkSpecification.getDefaults.
 */
export interface VolumeChunkSpecificationBaseOptions {
  /**
   * Origin of chunk grid, in nanometers, in global coordinates.
   */
  chunkLayoutOffset?: Vec3;

  /**
   * Transform from grid coordinates to global coordinates.
   */
  chunkLayoutRotation?: Quat;

  /**
   * Reflection coefficient, either 1 or -1, to apply to z axis of local coordinates prior to
   * rotation.
   */
  chunkLayoutZReflection?: number;

  /**
   * Voxel size in nanometers.
   */
  voxelSize: Vec3;

  numChannels: number;
  dataType: DataType;

  /**
   * Lower clipping bound (in nanometers), relative to chunkLayout coordinates.  If not specified,
   * defaults to lowerVoxelBound * voxelSize.
   *
   * Both lowerClipBound and upperClipBound are applied during rendering but do not affect which
   * chunks/voxels are actually retrieved.  That is determined by lowerVoxelBound and
   * upperVoxelBound.
   */
  lowerClipBound?: Vec3;

  /**
   * Upper clipping bound (in nanometers), relative to chunkLayout coordinates.  If not specified,
   * defaults to upperVoxelBound * voxelSize.
   */
  upperClipBound?: Vec3;

  /**
   * If not specified, defaults to (0, 0, 0).  This determines lowerChunkBound.  If this is not a
   * multiple of chunkDataSize, then voxels at lower positions may still be requested.
   */
  lowerVoxelBound?: Vec3;

  /**
   * Upper voxel bound, relative to chunkLayout coordinates.  This determines upperChunkBound.
   */
  upperVoxelBound: Vec3;

  /**
   * Specifies offset for use by backend.ts:VolumeChunkSource.computeChunkBounds in calculating
   * chunk voxel coordinates.  The calculated chunk coordinates will be equal to the voxel position
   * (in chunkLayout coordinates) plus this value.
   *
   * Defaults to kZeroVec if not specified.
   */
  baseVoxelOffset?: Vec3;

  /**
   * If set, indicates that the chunk is in compressed segmentation format with the specified block
   * size.
   */
  compressedSegmentationBlockSize?: Vec3;
}

/**
 * Specifies constructor parameters for VolumeChunkSpecification.
 */
export interface VolumeChunkSpecificationOptions extends VolumeChunkSpecificationBaseOptions {
  /**
   * Chunk size in voxels.
   */
  chunkDataSize: Vec3;
}


/**
 * Specifies additional parameters for VolumeChunkSpecification.withDefaultCompression.
 */
export interface VolumeChunkSpecificationDefaultCompressionOptions {
  /**
   * Volume type.
   */
  volumeType: VolumeType;
}

/**
 * Specifies parameters for VolumeChunkSpecification.getDefaults.
 */
export interface VolumeChunkSpecificationGetDefaultsOptions extends
    VolumeChunkSpecificationBaseOptions, VolumeChunkSpecificationDefaultCompressionOptions {
  /**
   * Chunk sizes in voxels.
   */
  chunkDataSizes?: Vec3[];

  /**
   * Maximum number of voxels per chunk.
   */
  maxVoxelsPerChunkLog2?: number;
}

/**
 * Specifies a chunk layout and voxel size.
 */
export class VolumeChunkSpecification {
  chunkLayout: ChunkLayout;
  numChannels: number;
  voxelSize: Vec3;
  dataType: DataType;
  chunkDataSize: Vec3;

  chunkBytes: number;

  // All valid chunks are in the range [lowerChunkBound, upperChunkBound).
  lowerChunkBound: Vec3;
  upperChunkBound: Vec3;

  lowerClipBound: Vec3;
  upperClipBound: Vec3;

  lowerVoxelBound: Vec3;
  upperVoxelBound: Vec3;

  baseVoxelOffset: Vec3;

  compressedSegmentationBlockSize: Vec3|undefined;

  constructor(options: VolumeChunkSpecificationOptions) {
    let {dataType,
         lowerVoxelBound = kZeroVec,
         upperVoxelBound,
         chunkDataSize,
         chunkLayoutOffset = kZeroVec,
         chunkLayoutRotation = kIdentityQuat,
         chunkLayoutZReflection = 1,
         voxelSize,
         baseVoxelOffset = kZeroVec,
         numChannels} = options;
    let {lowerClipBound = vec3.multiply(vec3.create(), voxelSize, lowerVoxelBound),
         upperClipBound = vec3.multiply(vec3.create(), voxelSize, upperVoxelBound)} = options;
    this.dataType = options.dataType;
    this.numChannels = numChannels;
    this.voxelSize = voxelSize;
    this.chunkDataSize = chunkDataSize;
    this.chunkLayout = ChunkLayout.get(
        vec3.multiply(vec3.create(), options.chunkDataSize, voxelSize), chunkLayoutOffset,
        chunkLayoutRotation, chunkLayoutZReflection);
    this.chunkBytes = prod3(options.chunkDataSize) * DATA_TYPE_BYTES[dataType] * numChannels;
    this.lowerClipBound = lowerClipBound;
    this.upperClipBound = upperClipBound;
    this.lowerVoxelBound = lowerVoxelBound;
    this.upperVoxelBound = upperVoxelBound;
    this.baseVoxelOffset = baseVoxelOffset;

    let lowerChunkBound = this.lowerChunkBound = vec3.create();
    let upperChunkBound = this.upperChunkBound = vec3.create();
    for (let i = 0; i < 3; ++i) {
      lowerChunkBound[i] = Math.floor(lowerVoxelBound[i] / chunkDataSize[i]);
      upperChunkBound[i] = Math.floor((upperVoxelBound[i] - 1) / chunkDataSize[i] + 1);
    }
    this.compressedSegmentationBlockSize = options.compressedSegmentationBlockSize;
  }
  static fromObject(msg: any) { return new VolumeChunkSpecification(msg); }
  toObject(): VolumeChunkSpecificationOptions {
    return {
      chunkLayoutOffset: this.chunkLayout.offset,
      chunkLayoutRotation: this.chunkLayout.rotation,
      chunkLayoutZReflection: this.chunkLayout.zReflection,
      numChannels: this.numChannels,
      chunkDataSize: this.chunkDataSize,
      voxelSize: this.voxelSize,
      dataType: this.dataType,
      lowerVoxelBound: this.lowerVoxelBound,
      upperVoxelBound: this.upperVoxelBound,
      lowerClipBound: this.lowerClipBound,
      upperClipBound: this.upperClipBound,
      baseVoxelOffset: this.baseVoxelOffset,
      compressedSegmentationBlockSize: this.compressedSegmentationBlockSize,
    };
  }

  /**
   * Returns a VolumeChunkSpecification with default compression specified if suitable for the
   * volumeType.
   */
  static withDefaultCompression(options: VolumeChunkSpecificationDefaultCompressionOptions&
                                VolumeChunkSpecificationOptions) {
    let {compressedSegmentationBlockSize, dataType, voxelSize, lowerVoxelBound, upperVoxelBound} =
        options;
    if (compressedSegmentationBlockSize === undefined &&
        options.volumeType === VolumeType.SEGMENTATION &&
        (dataType === DataType.UINT32 || dataType === DataType.UINT64)) {
      compressedSegmentationBlockSize = getNearIsotropicBlockSize(
          {voxelSize, lowerVoxelBound, upperVoxelBound, maxVoxelsPerChunkLog2: 9});
    }
    return new VolumeChunkSpecification(
        Object.assign({}, options, {compressedSegmentationBlockSize}));
  }

  static getDefaults(options: VolumeChunkSpecificationGetDefaultsOptions) {
    let {chunkDataSizes = [getNearIsotropicBlockSize(options)]} = options;
    return chunkDataSizes.map(
        chunkDataSize => VolumeChunkSpecification.withDefaultCompression(
            Object.assign({}, options, {chunkDataSize})));
  }
};

export interface VolumeChunkSource { spec: VolumeChunkSpecification; }

export const SLICEVIEW_RPC_ID = 'SliceView';
export const SLICEVIEW_RENDERLAYER_RPC_ID = 'sliceview/RenderLayer';
