var io = require('socket.io');
var rfb = require('rfb2');
var PNG = require('pngjs').PNG;
var EventEmitter = require('events');

/* Helper Functions */
var brgaToRgb = function(src){
  var rgb = new Buffer(src.length / 4 * 3);
  for (var i = 0, o = 0; i < src.length; i += 4) {
    rgb[o++] = src[i + 2];
    rgb[o++] = src[i + 1];
    rgb[o++] = src[i];
  }
  return rgb;
}

var brgaToRgba = function(src){
  var rgba = new Buffer(src.length);
  for (var i = 0; i < src.length; i += 4) {
    rgba[i] = src[i + 2];
    rgba[i + 1] = src[i + 1];
    rgba[i + 2] = src[i];
    //rgba[i + 3] = src[i + 3];
    rgba[i + 3] = 0xff;
  }
  return rgba;
}

/* Constructor */
var Server = function(server, options){
  if(!server){
    throw new Error('SimpleVNC needs a httpServer instance');
    return;
  }

  this.options = options || {};
  this.clients = [];
  this.currentFrame = null;
  this.event = new EventEmitter();
  this.on = this.event.on.bind(this.event);
  this.io = io(server, {path: options.path, log: false});
  this.io.sockets.on('connection', this.connectClient.bind(this));
}

Server.prototype.error = function(err){
  if(!this.event.emit('error', err))
    throw err
}

Server.prototype.extendFrame = function(){

}

Server.prototype.encodeFrame = function(rect, cb) {
  // raw transmission
  if(!this.options.png) {
    cb({
      encoding: 'raw',
      data: brgaToRgba(rect.data)
    });

  // png encoded frames
  } else {
    var rgba = brgaToRgba(rect.data),
      buffers = [],
      png = new PNG({
        width: rect.width,
        height: rect.height
      });
    rgba.copy(png.data, 0, 0, rgba.length);
    png.on('error', function(error){
      this.error(new Error('PNG error: ' + error.message));
    })
    png.on('data', function(buf) {
      buffers.push(buf);
    });
    png.on('end', function() {
      cb({
        encoding: 'png',
        data: Buffer.concat(buffers).toString('base64')
      })
    });
    png.pack();
  }
}

Server.prototype.addEventHandlers = function(client) {
  var self = this,
    socket = client.socket,
    rfbc = client.rfbc,
    initialFrame = false,
    last = 0;

  var handleConnection = function() {
    rfbc.autoUpdate = true;
    socket.emit('init', {
      width: rfbc.width,
      height: rfbc.height
    });
    client.interval= setInterval(function() {
      if(!initialFrame){
        rfbc.requestUpdate(false, 0, 0, rfbc.width, rfbc.height);
      }
    }, 300);
    self.clients.push(client);
    self.event.emit('connect', client)
  }

  rfbc.on('connect', handleConnection);
  rfbc.on('error', function(error) {
    self.error(new Error('RFB error: ' + error.message));
    self.disconnectClient(client);
  });
  rfbc.on('bell', socket.emit.bind(socket, 'bell'));
  rfbc.on('clipboard', function(newPasteBufData) {
    console.log('remote clipboard updated!', newPasteBufData);
  });
  rfbc.on('*', function() {
    self.error(new Error('rfb things: ' + error.message));
  });
  rfbc.on('rect', function(rect) {
    if(!initialFrame)
      initialFrame = true;

    var now = +new Date();
    last = now;

    var sendFrame = function(image){
      socket.emit('frame', {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        image: image
      });
    }

    switch(rect.encoding) {
    case rfb.encodings.raw:
      // rect.x, rect.y, rect.width, rect.height, rect.data
      // pixmap format is in rfbc.bpp, rfbc.depth, rfbc.redMask, greenMask, blueMask, redShift, greenShift, blueShift
      self.encodeFrame(rect, sendFrame);
      break;
    case rfb.encodings.copyRect:
      socket.emit('copyFrame', {
        x: rect.x,
        y: rect.y,
        src: rect.src,
        width: rect.width,
        height: rect.height
      });
      // pseudo-rectangle
      // copy rectangle from rect.src.x, rect.src.y, rect.width, rect.height, to rect.x, rect.y
      break;
    case rfb.encodings.hextile:
      rect.on('tile', function() {
        throw new Error('Hextile not implemented');
      }); // emitted for each subtile
      break;
    }
  });
}

Server.prototype.createConnection = function(config, socket) {
  var rfbc;
  try {
    rfbc = rfb.createConnection({
      host: config.host,
      port: config.port,
      password: config.password
    });
  } catch(error) {
    self.error(new Error('RFB error: ' + error.message));
  }
  return rfbc;
}

Server.prototype.connectClient = function(socket){
  var self = this;
  socket.on('init', function(config) {
    var client = {
      config: config,
      socket: socket,
    };
    var rfbc = client.rfbc = self.createConnection(config, socket);
    self.addEventHandlers(client);
    socket.on('mouse', function(event) {
      rfbc.pointerEvent(event.x, event.y, event.button);
    });
    socket.on('keyboard', function(event) {
      rfbc.keyEvent(event.keyCode, event.isDown);
    });
    socket.on('disconnect', function() {
      self.disconnectClient(client);
    });
    self.event.emit('establishing', client);
  });
}

Server.prototype.disconnectClient = function(client) {
  for(var i = 0; i < this.clients.length; i++) {
    var c = this.clients[i];
    if (c == client) {
      c.rfbc.end();
      clearInterval(c.interval);
      this.event.emit('disconnect', client, this.clients)
      this.clients.splice(i, 1);
      break;
    }
  }
}

module.exports = Server;
