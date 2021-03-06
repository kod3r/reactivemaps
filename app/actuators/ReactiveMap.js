import { default as React, Component } from 'react';
import { GoogleMapLoader, GoogleMap, Marker, SearchBox, InfoWindow } from "react-google-maps";
import InfoBox from 'react-google-maps/lib/addons/InfoBox';
import MarkerClusterer from "react-google-maps/lib/addons/MarkerClusterer";
import { SearchAsMove } from '../addons/SearchAsMove';
import { MapStyles, mapStylesCollection } from '../addons/MapStyles';
import classNames from 'classnames';
import {
	AppbaseChannelManager as manager,
	AppbaseSensorHelper as helper,
	PoweredBy
} from '@appbaseio/reactivebase';
var _ = require('lodash');

export class ReactiveMap extends Component {
	constructor(props, context) {
		super(props);
		this.state = {
			markers: [],
			selectedMarker: null,
			streamingStatus: 'Intializing..',
			center: this.props.defaultCenter,
			query: {},
			rawData: {
				hits: {
					hits: []
				}
			},
			externalData: {},
			mapBounds: null
		};
		this.previousSelectedSensor = {};
		this.handleSearch = this.handleSearch.bind(this);
		this.searchAsMoveChange = this.searchAsMoveChange.bind(this);
		this.mapStyleChange = this.mapStyleChange.bind(this);
		this.queryStartTime = 0;
		this.reposition = false;
	}

	getMapStyle(styleName) {
		let selectedStyle = mapStylesCollection.filter(function(style) {
			return style.key === styleName;
		});

		if (selectedStyle.length) {
			return selectedStyle[0].value;
		} else {
			return null;
		}
	}

	componentDidMount() {
		this.streamProp = this.props.stream;
		this.sizeProp = this.props.size;
		this.initialize();
	}

	initialize(updateExecute=false) {
		this.createChannel(updateExecute);
		this.setGeoQueryInfo();
		let currentMapStyle = this.getMapStyle(this.props.defaultMapStyle);
		this.setState({
			currentMapStyle: currentMapStyle
		});
	}

	componentWillUpdate() {
		setTimeout(() => {
			if (this.streamProp != this.props.stream) {
				this.streamProp = this.props.stream;
				this.removeChannel();
				this.initialize();
			}
			if (this.sizeProp != this.props.size) {
				this.sizeProp = this.props.size;
				this.removeChannel();
				this.initialize(true);
			}
		}, 300);
	}

	componentWillReceiveProps(nextProps) {
		if (nextProps.defaultMapStyle != this.props.defaultMapStyle) {
			this.mapStyleChange(this.getMapStyle(nextProps.defaultMapStyle));
		}
	}

	// stop streaming request and remove listener when component will unmount
	componentWillUnmount() {
		this.removeChannel();
	}

	removeChannel() {
		if(this.channelId) {
			manager.stopStream(this.channelId);
			this.channelId = null;
		}
		if(this.channelListener) {
			this.channelListener.remove();
		}
	}

	// Create a channel which passes the actuate and receive results whenever actuate changes
	createChannel(updateExecute=false) {
		// Set the actuate - add self aggs query as well with actuate
		let actuate = this.props.actuate ? this.props.actuate : {};
		actuate['geoQuery'] = { operation: "must" };
		actuate.streamChanges = {operation: 'must'};
		// create a channel and listen the changes
		var channelObj = manager.create(this.context.appbaseRef, this.context.type, actuate, this.props.size, this.props.from, this.props.stream);
		this.channelId = channelObj.channelId;
		this.channelListener = channelObj.emitter.addListener(channelObj.channelId, function(res) {
			let data = res.data;
			// implementation to prevent initialize query issue if old query response is late then the newer query
			// then we will consider the response of new query and prevent to apply changes for old query response.
			// if queryStartTime of channel response is greater than the previous one only then apply changes
			if(!this.state.mapBounds) {
				checkAndGo.call(this);
			} else {
				if(this.props.autoMapRender) {
					checkAndGo.call(this);
				} else {
					if(data.hits.hits.length) {
						checkAndGo.call(this);
					}
				}
			}
			function checkAndGo() {
				if(res.mode === 'historic' && res.startTime > this.queryStartTime) {
					this.afterChannelResponse(res);
				} else if(res.mode === 'streaming') {
					this.afterChannelResponse(res);
				}
			}
		}.bind(this));
		var obj = {
			key: 'streamChanges',
			value: ''
		};
		helper.selectedSensor.set(obj, true);
	}

	afterChannelResponse(res) {
		let data = res.data;
		let rawData, markersData;
		this.streamFlag = false;
		if(res.mode === 'streaming') {
			this.channelMethod = 'streaming';
			let modData = this.streamDataModify(this.state.rawData, res);
			rawData = modData.rawData;
			res = modData.res;
			this.streamFlag = true;
			markersData = this.setMarkersData(rawData);
		} else if(res.mode === 'historic') {
			this.channelMethod = 'historic';
			this.queryStartTime = res.startTime;
			rawData = data;
			markersData = this.setMarkersData(data);
		}
		this.reposition = true;
		this.setState({
			rawData: rawData,
			markersData: markersData
		}, function() {
			// Pass the historic or streaming data in index method
			res.allMarkers = rawData;
			res.mapRef = this.refs.map;
			if(this.props.onData) {
				let generatedData = this.props.onData(res);
				this.setState({
					externalData: generatedData
				});
			}
			if(this.streamFlag) {
				this.streamMarkerInterval();
			}
		}.bind(this));
	}

	// append stream boolean flag and also start time of stream
	streamDataModify(rawData, res) {
		if(res.data) {
			res.data.stream = true;
			res.data.streamStart = new Date();
			if(res.data._deleted) {
				let hits = rawData.hits.hits.filter((hit) => {
					return hit._id !== res.data._id;
				});
				rawData.hits.hits = hits;
			} else {
				let prevData = rawData.hits.hits.filter((hit) => {
					return hit._id === res.data._id;
				});
				if(prevData && prevData.length) {
					let preCord = prevData[0]._source[this.props.appbaseField];
					let newCord = res.data._source[this.props.appbaseField];
					res.data.angleDeg = this.bearing(preCord.lat, preCord.lon, newCord.lat, newCord.lon);
				}
				let hits = rawData.hits.hits.filter((hit) => {
					return hit._id !== res.data._id;
				});
				rawData.hits.hits = hits;
				rawData.hits.hits.push(res.data);
			}
		}
		return {
			rawData: rawData,
			res: res,
			streamFlag: true
		};
	}

	bearing (lat1,lng1,lat2,lng2) {
		var dLon = this._toRad(lng2-lng1);
		var y = Math.sin(dLon) * Math.cos(this._toRad(lat2));
		var x = Math.cos(this._toRad(lat1))*Math.sin(this._toRad(lat2)) - Math.sin(this._toRad(lat1))*Math.cos(this._toRad(lat2))*Math.cos(dLon);
		var brng = this._toDeg(Math.atan2(y, x));
		return ((brng + 360) % 360);
	}

	_toRad(deg) {
		 return deg * Math.PI / 180;
	}

	_toDeg(rad) {
		return rad * 180 / Math.PI;
	}

	// tranform the raw data to marker data
	setMarkersData(data) {
		var self = this;
		if(data && data.hits && data.hits.hits) {
			let markersData = data.hits.hits.map((hit, index) => {
				hit._source.mapPoint = self.identifyGeoData(hit._source[self.props.appbaseField]);
				return hit;
			});
			markersData = markersData.filter((hit, index) => {
				return hit._source.mapPoint && !(hit._source.mapPoint.lat === 0 && hit._source.mapPoint.lng === 0);
			});
			markersData = this.sortByDistance(markersData);
			markersData = markersData.map((marker) => {
				marker.showInfo = false;
				return marker;
			});
			return markersData;
		} else {
			return [];
		}
	}

	// centrialize the map
	// calculate the distance from each marker to other marker,
	// summation of all the distance and sort by distance in ascending order
	sortByDistance(data) {
		let modifiedData = data.map((record) => {
			record.distance = this.findDistance(data, record);
			return record;
		});
		modifiedData = _.orderBy(modifiedData, 'distance');
		return modifiedData;
	}

	findDistance(data, record) {
		record.distance = 0;
		let modifiednData = data.map((to) => {
			record.distance += getDistance(record._source.mapPoint.lat, record._source.mapPoint.lng, to._source.mapPoint.lat, to._source.mapPoint.lng);
		});
		function getDistance(lat1,lon1,lat2,lon2) {
			var R = 6371; // Radius of the earth in km
			var dLat = deg2rad(lat2-lat1);  // deg2rad below
			var dLon = deg2rad(lon2-lon1);
			var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
					Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
					Math.sin(dLon/2) * Math.sin(dLon/2);
			var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
			var d = R * c; // Distance in km
			return d;
		}
		function deg2rad(deg) {
			return deg * (Math.PI/180)
		}
		return record.distance;
	}

	// set the query type and input data
	setGeoQueryInfo() {
		var obj = {
				key: 'geoQuery',
				value: {
					queryType: 'geo_bounding_box',
					inputData: this.props.appbaseField
				}
		};
		var obj1 = {
				key: 'updateExecute',
				value: {
					queryType: 'random',
					inputData: this.props.appbaseField
				}
		};

		helper.selectedSensor.setSensorInfo(obj);
		helper.selectedSensor.setSensorInfo(obj1);
	}

	updateExecute() {
		setTimeout(() => {
			var obj = {
				key: 'updateExecute',
				value: Math.random()
			};
			helper.selectedSensor.set(obj, true);
		}, 1000);
	}

	// Show InfoWindow and re-renders component
	handleMarkerClick(marker) {
		marker.showInfo = true;
		this.reposition = false;
		this.setState({
			rerender: true
		});
	}

	// Close infowindow
	handleMarkerClose(marker) {
		marker.showInfo = false;
		this.reposition = false;
		this.setState(this.state);
	}

	// render infowindow
	renderInfoWindow(ref, marker) {
		var onPopoverTrigger = this.props.onPopoverTrigger ? this.props.onPopoverTrigger(marker) : 'Popver';
		return (
			<InfoWindow
				zIndex = {500}
				key={`${ref}_info_window`}
				onCloseclick={this.handleMarkerClose.bind(this, marker)} >
				<div>
					{onPopoverTrigger}
				</div>
			</InfoWindow>
		);
	}

	// Handle function which is fired when map is moved and reaches to idle position
	handleOnIdle() {
		var mapBounds = this.refs.map.getBounds();
		if(mapBounds) {
			var north = mapBounds.getNorthEast().lat();
			var south = mapBounds.getSouthWest().lat();
			var east = mapBounds.getNorthEast().lng();
			var west = mapBounds.getSouthWest().lng();
			var boundingBoxCoordinates = {
				"top_left": [west, north],
				"bottom_right": [east, south]
			};
			var stateObj = {
				mapBounds: mapBounds
			};
			if(this.props.onIdle) {
				let generatedData = this.props.onIdle(this.refs.map, {
					boundingBoxCoordinates: boundingBoxCoordinates,
					mapBounds: mapBounds
				});
				stateObj.externalData = generatedData;
			}
			if(this.searchAsMove && !this.searchQueryProgress) {
				this.setValue(boundingBoxCoordinates, this.searchAsMove);
			}
			this.setState(stateObj);
		}
	}

	// Handle function which is fired when map is dragged
	handleOnDrage() {
		this.storeCenter = null;
	}

	// set value
	setValue(value, isExecuteQuery=false) {
		var obj = {
			key: 'geoQuery',
			value: value
		};
		helper.selectedSensor.set(obj, isExecuteQuery);
	}

	// on change of selectiong
	searchAsMoveChange(value) {
		this.searchAsMove = value;
		if(value && this.refs.map) {
			this.handleOnIdle();
		}
	}

	// mapStyle changes
	mapStyleChange(style) {
		this.setState({
			currentMapStyle: style
		});
	}

	// Handler function for bounds changed which udpates the map center
	handleBoundsChanged() {
		if(!this.searchQueryProgress) {
			// this.setState({
			//   center: this.refs.map.getCenter()
			// });
		} else {
			setTimeout(()=> {
				this.searchQueryProgress = false;
			}, 1000*1);
		}
	}

	// Handler function which is fired when an input is selected from autocomplete google places
	handlePlacesChanged() {
		const places = this.refs.searchBox.getPlaces();
		// this.setState({
		//   center: places[0].geometry.location
		// });
	}

	// Handler function which is fired when an input is selected from Appbase geo search field
	handleSearch(location) {
		// this.setState({
		//   center: new google.maps.LatLng(location.value.lat, location.value.lon)
		// });
	}

	identifyGeoData(input) {
		let type = Object.prototype.toString.call(input);
		let convertedGeo = null;
		if(type === '[object Object]' && input.hasOwnProperty('lat') && input.hasOwnProperty('lon')) {
			convertedGeo = {
				lat: Number(input.lat),
				lng: Number(input.lon)
			};
		}
		else if(type === '[object Array]' && input.length === 2) {
			convertedGeo = {
				lat: Number(input[0]),
				lng: Number(input[1])
			};
		}
		return convertedGeo;
	}

	// Check if stream data exists in markersData
	// and if exists the call streamToNormal.
	streamMarkerInterval() {
		let markersData = this.state.markersData;
		let isStreamData = markersData.filter((hit) => hit.stream && hit.streamStart);
		if(isStreamData.length) {
			this.isStreamDataExists = true;
			setTimeout(() => this.streamToNormal(), this.props.streamTTL*1000);
		} else {
			this.isStreamDataExists = false;
		}
	}

	// Check the difference between current time and attached stream time
	// if difference is equal to streamTTL then delete stream and starStream property of marker
	streamToNormal() {
		let markersData = this.state.markersData;
		let isStreamData = markersData.filter((hit) => hit.stream && hit.streamStart);
		if(isStreamData.length) {
			markersData = markersData.map((hit, index) => {
				if(hit.stream && hit.streamStart) {
					let currentTime = new Date();
					let timeDiff = (currentTime.getTime() - hit.streamStart.getTime())/1000;
					if(timeDiff >= this.props.streamTTL) {
						delete hit.stream;
						delete hit.streamStart;
					}
				}
				return hit;
			});
			this.setState({
				markersData: markersData
			});
		} else {
			this.isStreamDataExists = false;
		}
	}

	chooseIcon(hit) {
		let icon = hit.external_icon ? hit.external_icon : (hit.stream ? this.props.streamMarkerImage : this.props.defaultMarkerImage);
		let isSvg = typeof icon === 'object' && icon.hasOwnProperty('path') ? true : false;
		if(isSvg) {
			icon = JSON.parse(JSON.stringify(icon));
			if(this.props.autoMarkerPosition) {
				let deg = hit.angleDeg ? hit.angleDeg : 0;
				icon.rotation = deg;
			}
		}
		return icon;
	}

	// here we accepts marker props which we received from onData and apply those external props in Marker component
	combineProps(hit) {
		let externalProps, markerProp = {};
		if(this.state.externalData && this.state.externalData.markers && this.state.externalData.markers[hit._id]) {
			externalProps = this.state.externalData.markers[hit._id]
			for(let external_p in externalProps) {
				hit["external_"+external_p] = externalProps[external_p];
				markerProp[external_p] = externalProps[external_p];
			}
		}
		markerProp.icon = this.chooseIcon(hit);
		return markerProp;
	}

	generateMarkers() {
		var self = this;
		let markersData = this.state.markersData;
		let response = {
			markerComponent: [],
			defaultCenter: null,
			convertedGeo: []
		};
		if(markersData && markersData.length) {
			response.markerComponent = markersData.map((hit, index) => {
				let field = self.identifyGeoData(hit._source[self.props.appbaseField]);
				// let icon = !this.props.autoMarkerPosition ? iconPath : RotateIcon.makeIcon(iconPath).setRotation({deg: deg}).getUrl();
				// let icon = self.chooseIcon(hit);
				if(field) {
					response.convertedGeo.push(field);
					let position = {
						position: field
					};
					let ref = `marker_ref_${index}`;
					let popoverEvent;
					if(this.props.showPopoverOn) {
						popoverEvent = {};
						let eventName = this.props.showPopoverOn.split('');
						eventName[0] = eventName[0].toUpperCase();
						eventName = eventName.join('');
						popoverEvent['on'+eventName] = this.handleMarkerClick.bind(this, hit);
					} else {
						popoverEvent = {};
						popoverEvent['onClick'] = this.handleMarkerClick.bind(this, hit);
					}
					let defaultFn = function(){};
					let events = {
						onClick: this.props.markerOnClick ? this.props.markerOnClick : defaultFn,
						onDblclick: this.props.markerOnDblclick ? this.props.markerOnDblclick : defaultFn,
						onMouseover: this.props.onMouseover ? this.props.onMouseover : defaultFn,
						onMouseout: this.props.onMouseout ? this.props.onMouseout : defaultFn
					};
					let timenow = new Date();
					return (
						<Marker {...position}
							key={hit._id}
							zIndex={1}
							ref={ref}
							{...self.combineProps(hit)}
							onClick={() => events.onClick(hit._source)}
							onDblclick={() => events.onDblclick(hit._source)}
							onMouseover={() => events.onMouseover(hit._source)}
							onMouseout={() => events.onMouseout(hit._source)}
							{...popoverEvent}>
							{hit.showInfo ? self.renderInfoWindow(ref, hit) : null}
						</Marker>
					)
				}
			});
			if(response.convertedGeo[0]) {
				response.defaultCenter = {
					lat: response.convertedGeo[0].lat,
					lng: response.convertedGeo[0].lng
				};
			}
		}
		if(!this.props.showMarkers) {
			response.markerComponent = [];
		}
		return response;
	}

	externalData() {
		let recordList = [];
		if(this.state.externalData) {
			for(let record in this.state.externalData) {
				if(record !== 'markers') {
					recordList = recordList.concat(this.state.externalData[record]);
				}
			}
		}
		return recordList;
	}

	mapEvents(eventName) {
		if(this.props[eventName]) {
			let externalData = this.props[eventName](this.refs.map);
			if(externalData) {
				this.setState({
					externalData: externalData
				});
			}
		}
	}

	render() {
		var self = this;
		var markerComponent, showSearchAsMove, showMapStyles;
		let appbaseSearch, title = null, center = null;
		let centerComponent = {};
		var otherOptions;
		var generatedMarkers = this.generateMarkers();
		if (this.props.setMarkerCluster) {
			markerComponent = <MarkerClusterer averageCenter enableRetinaIcons gridSize={ 60 } >
				{generatedMarkers.markerComponent}
			</MarkerClusterer>;
		}
		else {
			markerComponent = generatedMarkers.markerComponent;
		}
		// Auto center using markers data
		var streamCenterFlag = true;
		if(this.channelMethod === 'streaming' && !this.props.streamAutoCenter) {
			streamCenterFlag = false;
		}
		if(!this.searchAsMove && this.props.autoCenter && this.reposition && streamCenterFlag) {
			center =  generatedMarkers.defaultCenter ? generatedMarkers.defaultCenter : (this.storeCenter ? this.storeCenter : this.state.center);
			this.storeCenter = center;
			this.reposition = false;
			centerComponent.center = center;
		} else {
			if(this.storeCenter) {
				center = this.storeCenter;
				centerComponent.center = center;
			} else {
				center = null;
			}
		}
		// include searchasMove component
		if(this.props.showSearchAsMove) {
			showSearchAsMove = <SearchAsMove searchAsMoveDefault={this.props.setSearchAsMove} searchAsMoveChange={this.searchAsMoveChange} />;
		}
		// include mapStyle choose component
		if(this.props.showMapStyles) {
			showMapStyles = <MapStyles defaultSelected={this.props.defaultMapStyle} mapStyleChange={this.mapStyleChange} />;
		}
		// include title if exists
		if(this.props.title) {
			title = (<h4 className="rbc-title col s12 m8 col-xs-12 col-sm-8">{this.props.title}</h4>);
		}

		let cx = classNames({
			'rbc-title-active': this.props.title,
			'rbc-title-inactive': !this.props.title
		});

		return(
			<div className={`rbc rbc-reactivemap col s12 col-xs-12 card thumbnail ${cx}`} style={this.props.componentStyle}>
				{title}
				{showMapStyles}
				<GoogleMapLoader
					containerElement={
						<div className="rbc-container col s12 col-xs-12" style={this.props.containerStyle}/>
					}
					googleMapElement={
						<GoogleMap ref = "map"
							options = {{
								styles: this.state.currentMapStyle
							}}
							{...centerComponent}
							{...this.props}
								onDragstart = {() => {
									this.handleOnDrage()
									this.mapEvents('onDragstart');
								}
							}
							onIdle = {() => this.handleOnIdle()}
							onClick = {() => this.mapEvents('onClick')}
							onDblclick = {() => this.mapEvents('onDblclick')}
							onDrag = {() => this.mapEvents('onDrag')}
							onDragend = {() => this.mapEvents('onDragend')}
							onMousemove = {() => this.mapEvents('onMousemove')}
							onMouseout = {() => this.mapEvents('onMouseout')}
							onMouseover = {() => this.mapEvents('onMouseover')}
							onResize = {() => this.mapEvents('onResize')}
							onRightclick = {() => this.mapEvents('onRightclick')}
							onTilesloaded = {() => this.mapEvents('onTilesloaded')}
							onBoundsChanged = {() => this.mapEvents('onBoundsChanged')}
							onCenterChanged = {() => this.mapEvents('onCenterChanged')}
							onProjectionChanged = {() => this.mapEvents('onProjectionChanged')}
							onTiltChanged = {() => this.mapEvents('onTiltChanged')}
							onZoomChanged = {() => this.mapEvents('onZoomChanged')}
						>
							{markerComponent}
							{this.externalData()}
						</GoogleMap>
					}
				/>
				{showSearchAsMove}
				<PoweredBy />
			</div >
		);
	}
}

var validation = {
	defaultZoom: function(props, propName, componentName) {
		if (props[propName] < 0 || props[propName] > 20) {
			return new Error('zoom value should be an integer between 0 and 20.');
		}
	},
	validCenter: function(props, propName, componentName) {
		if(isNaN(props[propName])) {
			return new Error(propName+' value must be number');
		} else {
			if(propName === 'lat' && (props[propName] < -90 || props[propName] > 90)) {
				return new Error(propName+' value should be between -90 and 90.');
			}
			else if(propName === 'lng' && (props[propName] < -180 || props[propName] > 180)) {
				return new Error(propName+' value should be between -180 and 180.');
			}
		}
	},
	fromValidation: function(props, propName, componentName) {
		if (props[propName] < 0) {
			return new Error(propName+' value should be greater than or equal to 0.');
		}
	},
	streamTTL: function(props, propName, componentName) {
		if (props[propName] < 0 || props[propName] > 1000 ) {
			return new Error(propName+' should be a positive integer between 0 and 1000, counted in seconds for a streaming update to be visible.');
		}
	}
}

ReactiveMap.propTypes = {
	appbaseField: React.PropTypes.string.isRequired,
	onIdle: React.PropTypes.func,
	onData: React.PropTypes.func,
	onPopoverTrigger: React.PropTypes.func,
	setMarkerCluster: React.PropTypes.bool,
	autoMarkerPosition: React.PropTypes.bool,
	showMarkers: React.PropTypes.bool,
	streamTTL: validation.streamTTL,
	size: helper.sizeValidation,
	from: validation.fromValidation,
	autoMapRender: React.PropTypes.bool, // usecase?
	componentStyle: React.PropTypes.object,
	containerStyle: React.PropTypes.object,
	autoCenter: React.PropTypes.bool,
	showSearchAsMove: React.PropTypes.bool,
	setSearchAsMove: React.PropTypes.bool,
	defaultMapStyle: React.PropTypes.oneOf(['Standard', 'Blue Essence', 'Blue Water', 'Flat Map', 'Light Monochrome', 'Midnight Commander', 'Unsaturated Browns']),
	title: React.PropTypes.string,
	streamAutoCenter: React.PropTypes.bool,
	defaultMarkerImage: React.PropTypes.string,
	streamMarkerImage: React.PropTypes.string,
	stream: React.PropTypes.bool,
	defaultZoom: validation.defaultZoom,
	showPopoverOn: React.PropTypes.oneOf(['click', 'mouseover']),
	defaultCenter: React.PropTypes.shape({
		lat: validation.validCenter,
		lng: validation.validCenter
	})
};

ReactiveMap.defaultProps = {
	setMarkerCluster: true,
	autoCenter: true,
	showSearchAsMove: true,
	setSearchAsMove: false,
	showMapStyles: true,
	defaultMapStyle: 'Standard',
	from: 0,
	size: 100,
	streamTTL: 5,
	streamAutoCenter: false,
	autoMarkerPosition: false,
	showMarkers: true,
	autoMapRender: true,
	defaultMarkerImage: 'https://cdn.rawgit.com/appbaseio/reactivemaps/6500c73a/dist/images/historic-pin.png',
	streamMarkerImage: 'https://cdn.rawgit.com/appbaseio/reactivemaps/6500c73a/dist/images/stream-pin.png',
	componentStyle: {},
	containerStyle: {
		height: '700px'
	},
	stream: false,
	defaultZoom: 13,
	defaultCenter: {
		"lat": 37.74,
		"lng": -122.45
	}
};

ReactiveMap.contextTypes = {
	appbaseRef: React.PropTypes.any.isRequired,
	type: React.PropTypes.any.isRequired
};
