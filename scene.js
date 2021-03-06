'use strict'

module.exports = createScene

var createCamera = require('3d-view-controls')
var createAxes   = require('gl-axes')
var createSpikes = require('gl-spikes')
var createSelect = require('gl-select-static')
var createFBO    = require('gl-fbo')
var drawTriangle = require('a-big-triangle')
var mouseChange  = require('mouse-change')
var perspective  = require('gl-mat4/perspective')
var createShader = require('./lib/shader')

function MouseSelect() {
  this.mouse          = [-1,-1]
  this.screen         = null
  this.distance       = Infinity
  this.index          = null
  this.dataCoordinate = null
  this.dataPosition   = null
  this.object         = null
  this.data           = null
}

function roundUpPow10(x) {
  var y = Math.round(Math.log(Math.abs(x)) / Math.log(10))
  if(y < 0) {
    var base = Math.round(Math.pow(10, -y))
    return Math.ceil(x*base) / base
  } else if(y > 0) {
    var base = Math.round(Math.pow(10, y))
    return Math.ceil(x/base) * base
  }
  return Math.ceil(x)
}

function defaultBool(x) {
  if(typeof x === 'boolean') {
    return x
  }
  return true
}

function createScene(canvas, options) {
  options = options || {}

  //Create WebGL context
  var glOptions = options.gl || { premultipliedAlpha: true }
  var gl = canvas.getContext('webgl', glOptions)
  var premultipliedAlpha = glOptions.premultipliedAlpha

  //Initial bounds
  var bounds = options.bounds || [[-10,-10,-10], [10,10,10]]

  //Create selection
  var selection = new MouseSelect()

  //Accumulation buffer
  var accumBuffer = createFBO(gl,
    [gl.drawingBufferWidth, gl.drawingBufferHeight], {
      preferFloat: true
    })

  var accumShader = createShader(gl)

  //Create a camera
  var cameraOptions = options.camera || {
    eye:    [0,0,2],
    center: [0,0,0],
    up:     [0,0,0],
    mode:   'orbit',
    zoomMin: 0.1,
    zoomMax: 100
  }
  var camera = createCamera(canvas, cameraOptions)

  //Create axes
  var axesOptions = options.axes || {}
  var axes = createAxes(gl, axesOptions)
  axes.enable = !axesOptions.disable

  //Create spikes
  var spikeOptions = options.spikes || {}
  var spikes = createSpikes(gl, spikeOptions)
  
  //Object list is empty initially
  var objects         = []
  var pickBufferIds   = []
  var pickBufferCount = []
  var pickBuffers     = []

  //Dirty flag, skip redraw if scene static
  var dirty       = true
  var pickDirty   = true
  
  //Create scene object
  var scene = {
    gl:           gl,
    canvas:       canvas,
    selection:    selection,
    camera:       camera,
    axes:         axes,
    spikes:       spikes,
    bounds:       bounds,
    objects:      objects,
    pickRadius:   options.pickRadius || 10,
    zNear:        options.zNear || 0.01,
    zFar:         options.zFar  || 1000,
    fovy:         options.fovy  || Math.PI/4,
    clearColor:   options.clearColor || [0,0,0,0],
    autoBounds:   defaultBool(options.autoBounds),
    autoScale:    defaultBool(options.autoScale),
    autoCenter:   defaultBool(options.autoCenter),
    clipToBounds: defaultBool(options.clipToBounds),
    snapToData:   !!options.snapToData
  }

  var projection     = new Array(16)
  var model          = new Array(16)
  
  var cameraParams = {
    view:         camera.matrix,
    projection:   projection,
    model:        model
  }

  var pickDirty = true

  function reallocPickIds() {
    var numObjs = objects.length
    var numPick = pickBuffers.length
    for(var i=0; i<numPick; ++i) {
      pickBufferCount[i] = 0
    }
    obj_loop:
    for(var i=0; i<numObjs; ++i) {
      var obj = objects[i]
      var pickCount = obj.pickSlots
      if(!pickCount) {
        pickBufferIds[i] = -1
        continue
      }
      for(var j=0; j<numPick; ++j) {
        if(pickBufferCount[j] + pickCount < 255) {
          pickBufferIds[i] = j
          obj.setPickBase(pickBufferCount[j]+1)
          pickBufferCount[j] += pickCount
          continue obj_loop
        }
      }
      //Create new pick buffer
      var nbuffer = createSelect(gl, [gl.drawingBufferWidth, gl.drawingBufferHeight])
      pickBufferIds[i] = numPick
      pickBuffers.push(nbuffer)
      pickBufferCount.push(pickCount)
      obj.setPickBase(1)
      numPick += 1
    }
    while(numPick > 0 && pickBufferCount[numPick-1] === 0) {
      pickBufferCount.pop()
      pickBuffers.pop().dispose()
    }
  }

  scene.addObject = function(obj) {
    objects.push(obj)
    pickBufferIds.push(-1)
    dirty = true
    pickDirty = true
    reallocPickIds()
  }

  scene.removeObject = function(obj) {
    var idx = objects.indexOf(obj)
    if(idx < 0) {
      return
    }
    objects.splice(idx, 1)
    pickBufferIds.pop()
    dirty = true
    pickDirty = true
    reallocPickIds()
  }

  scene.dispose = function() {
    axes.dispose()
    spikes.dispose()
    for(var i=0; i<objects.length; ++i) {
      objects[i].dispose()
    }
  }

  //Update mouse position
  var mouseRotating = false
  mouseChange(canvas, function(buttons, x, y) {
    var numPick = pickBuffers.length
    var numObjs = objects.length
    var prevObj = selection.object
    selection.distance = Infinity
    selection.mouse = [x, y]
    selection.object = null
    selection.screen = null
    selection.dataCoordinate = selection.dataPosition = null

    if(buttons) {
      mouseRotating = true
    } else {
      if(mouseRotating) {
        pickDirty = true
      }
      mouseRotating = false

      for(var i=0; i<numPick; ++i) {
        var result = pickBuffers[i].query(x, gl.drawingBufferHeight - y - 1, scene.pickRadius)
        if(result) {
          if(result.distance > selection.distance) {
            continue
          }
          for(var j=0; j<numObjs; ++j) {
            var obj = objects[j]
            if(pickBufferIds[j] !== i) {
              continue
            }
            var objPick = obj.pick(result)
            if(objPick) {
              selection.screen = result.coord
              selection.distance = result.distance
              selection.object = obj
              selection.index = objPick.distance
              selection.dataPosition = objPick.position
              selection.dataCoordinate = objPick.dataCoordinate
              selection.data = objPick
            }
          }
        }
      }
    }
    if(prevObj && prevObj !== selection.object) {
      if(prevObj.highlight) {
        prevObj.highlight(null)
      }
      dirty = true
    }
    if(selection.object) {
      if(selection.object.highlight) {
        selection.object.highlight(selection.data)
      }
      dirty = true
    }
  })

  //Render the scene for mouse picking
  function renderPick() {

    gl.colorMask(true, true, true, true)
    gl.depthMask(true)
    gl.disable(gl.BLEND)
    gl.enable(gl.DEPTH_TEST)

    var numObjs = objects.length
    var numPick = pickBuffers.length
    for(var j=0; j<numPick; ++j) {
      var buf = pickBuffers[j]
      buf.shape = [gl.drawingBufferWidth, gl.drawingBufferHeight]
      buf.begin()
      for(var i=0; i<numObjs; ++i) {
        if(pickBufferIds[i] !== j) {
          continue
        }
        var obj = objects[i]
        if(obj.drawPick) {
          obj.drawPick(cameraParams)
        }
      }
      buf.end()
    }
  }

  var nBounds = [
    [Infinity, Infinity, Infinity],
    [-Infinity,-Infinity,-Infinity]]

  //Draw the whole scene
  function render() {
    requestAnimationFrame(render)

    //Tick camera
    var cameraMoved = camera.tick()
    dirty     = dirty || cameraMoved
    pickDirty = pickDirty || cameraMoved

    //Check if any objects changed, recalculate bounds
    var numObjs = objects.length
    var lo = nBounds[0]
    var hi = nBounds[1]
    lo[0] = lo[1] = lo[2] =  Infinity
    hi[0] = hi[1] = hi[2] = -Infinity
    for(var i=0; i<numObjs; ++i) {
      var obj = objects[i]
      dirty = dirty || !!obj.dirty
      pickDirty = pickDirty || !!obj.dirty
      var obb = obj.bounds
      if(obb) {
        var olo = obb[0]
        var ohi = obb[1]
        for(var j=0; j<3; ++j) {
          lo[j] = Math.min(lo[j], olo[j])
          hi[j] = Math.max(hi[j], ohi[j])
        }
      }
    }

    //Recalculate bounds
    var bounds = scene.bounds
    if(scene.autoBounds) {
      var boundsChanged = false
      for(var j=0; j<3; ++j) {
        if(lo[j] === Infinity || hi[j] === -Infinity) {
          lo[j] = -1
          hi[j] = 1
        } else {
          var padding = 0.05 * (hi[j] - lo[j])
          lo[j] = lo[j] - padding
          hi[j] = hi[j] + padding
        }
        boundsChanged = boundsChanged ||
            (lo[j] !== bounds[0][j])  ||
            (hi[j] !== bounds[1][j])
      }
      if(boundsChanged) {
        var tickSpacing = [0,0,0]
        for(var i=0; i<3; ++i) {
          bounds[0][i] = lo[i]
          bounds[1][i] = hi[i]
          tickSpacing[i] = roundUpPow10((hi[i]-lo[i]) / 10.0)
        }
        console.log(bounds, tickSpacing)
        if(axes.autoTicks) {
          axes.update({
            bounds: bounds,
            tickSpacing: tickSpacing
          })
        } else {
          axes.update({
            bounds: bounds
          })
        }
      }
    }

    //Recalculate bounds
    pickDirty = pickDirty || boundsChanged
    dirty = dirty || boundsChanged

    //Get scene
    var width  = gl.drawingBufferWidth
    var height = gl.drawingBufferHeight

    //Compute camera parameters
    perspective(projection,
      scene.fovy,
      width/height,
      scene.zNear,
      scene.zFar)

    //Compute model matrix
    for(var i=0; i<16; ++i) {
      model[i] = 0
    }
    model[15] = 1
    var diameter = 0
    for(var i=0; i<3; ++i) {
      diameter = Math.max(bounds[1][i] - bounds[0][i])
    }
    for(var i=0; i<3; ++i) {
      if(scene.autoScale) {
        model[5*i] = 0.5 / diameter
      } else {
        model[5*i] = 1
      }
      if(scene.autoCenter) {
        model[12+i] = -model[5*i] * 0.5 * (bounds[0][i] + bounds[1][i])
      }
    }

    //Apply axes/clip bounds
    for(var i=0; i<numObjs; ++i) {
      var obj = objects[i]

      //Set axes bounds
      obj.axesBounds = bounds

      //Set clip bounds
      if(scene.clipToBounds) {
        obj.clipBounds = bounds
      }
    }

    //Set spike parameters
    if(selection.object) {
      if(scene.snapToData) {
        spikes.position = selection.dataCoordinate
      } else {
        spikes.position = selection.dataPosition
      }
      spikes.bounds = bounds
    }

    //If state changed, then redraw pick buffers
    if(pickDirty) {
      pickDirty = false
      renderPick()
    }

    if(!dirty) {
      return
    }

    //Read value
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)

    //General strategy: 3 steps
    //  1. render non-transparent objects
    //  2. accumulate transparent objects into separate fbo
    //  3. composite final scene

    //Clear FBO
    var clearColor = scene.clearColor
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3])
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.depthMask(true)
    gl.colorMask(true, true, true, true)  
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.disable(gl.BLEND)

    //Render opaque pass
    var hasTransparent = false
    if(axes.enable) {
      axes.draw(cameraParams)
    }
    if(selection.object) {
      spikes.draw(cameraParams)
    }
    gl.disable(gl.CULL_FACE)
    
    for(var i=0; i<numObjs; ++i) {
      var obj = objects[i]
      if(obj.isOpaque && obj.isOpaque()) {
        obj.draw(cameraParams)
      }
      if(obj.isTransparent && obj.isTransparent()) {
        hasTransparent = true
      }
    }

    if(hasTransparent) {
      //Render transparent pass
      accumBuffer.shape = [gl.drawingBufferWidth, gl.drawingBufferHeight]
      accumBuffer.bind()
      gl.clear(gl.DEPTH_BUFFER_BIT)
      gl.colorMask(false, false, false, false)
      gl.depthMask(true)
      
      //Initialize depth buffer
      if(axes.enable) {
        axes.draw(cameraParams)
      }
      if(spikes.enable && selection.objects) {
        spikes.draw(cameraParams)
      }
      gl.disable(gl.CULL_FACE)

      for(var i=0; i<numObjs; ++i) {
        var obj = objects[i]
        if(obj.isOpaque && obj.isOpaque()) {
          obj.draw(cameraParams)
        }
      }

      //Render transparent pass
      gl.enable(gl.BLEND)
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.colorMask(true, true, true, true)
      gl.depthMask(false)
      gl.clearColor(0,0,0,0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      for(var i=0; i<numObjs; ++i) {
        var obj = objects[i]
        if(obj.isTransparent && obj.isTransparent()) {
          obj.drawTransparent(cameraParams)
        }
      }

      //Unbind framebuffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)

      //Draw composite pass
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.disable(gl.DEPTH_TEST)
      accumShader.bind()
      accumBuffer.color[0].bind(0)
      accumShader.uniforms.accumBuffer = 0
      drawTriangle(gl)

      //Turn off blending
      gl.disable(gl.BLEND)
    }

    //Clear dirty flags
    dirty = false
    for(var i=0; i<numObjs; ++i) {
      objects[i].dirty = false
    }
  }
  render()

  return scene
}