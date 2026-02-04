import re
from typing import List, Dict, Any, Tuple
try:
    from shapely.geometry import Polygon, Point
    from shapely.strtree import STRtree
    SHAPELY_AVAILABLE = True
except ImportError:
    SHAPELY_AVAILABLE = False
    print("Warning: Shapely not installed. Spatial analysis will be skipped.")

class PIDProcessor:
    """
    Advanced P&ID Processor for Topology, Proximity, and Connectivity.
    Uses Shapely for spatial calculations.
    """
    
    def __init__(self):
        # Regex for common P&ID Tags (e.g., V-101, P-102A, 10"-PG-101)
        self.tag_pattern = re.compile(r'\b[A-Z0-9]+-[A-Z0-9-]+\b')
        # Regex for Off-page Connectors
        self.connector_pattern = re.compile(r'(SEE DWG|FROM DWG|TO DWG)\.?\s*([A-Z0-9-]+)', re.IGNORECASE)

    def process_chunk(self, chunk: Dict[str, Any]) -> Dict[str, Any]:
        """
        Enrich a document chunk with topological information.
        """
        if not SHAPELY_AVAILABLE or "lines" not in chunk:
            chunk["topology"] = {"status": "skipped", "reason": "No shapely or no lines"}
            return chunk

        lines = chunk.get("lines", [])
        words = chunk.get("words", [])
        
        # 1. Prepare Geometries
        # We focus on WORDS for fine-grained proximity, or LINES for general labels.
        # Let's use LINES for primary tag detection.
        
        elements = []
        geometries = []
        
        for i, item in enumerate(lines):
            poly = self._to_shapely(item.get("polygon"))
            if poly and poly.is_valid:
                elements.append({"index": i, "type": "line", "data": item, "poly": poly})
                geometries.append(poly)
        
        if not geometries:
            return chunk

        # Build Spatial Index
        tree = STRtree(geometries)
        
        topology = {
            "tags": [],
            "connectors": [],
            "valves": [] # Future expansion
        }
        
        # 2. Analyze Elements
        for elem in elements:
            text = elem["data"]["text"]
            poly = elem["poly"]
            
            # A. Tag Detection & Clustering
            if self.tag_pattern.search(text):
                # Find neighbors within X distance (e.g. 5% of page width?)
                # Since units vary, we use a heuristic buffer.
                # Let's assume 50 units (roughly).
                
                # Query index for neighbors
                # STRtree query returns indices of geometries
                query_geom = poly.buffer(50) 
                neighbor_indices = tree.query(query_geom)
                
                neighbors = []
                for idx in neighbor_indices:
                    if idx != elem["index"]: # Skip self
                        neighbor_elem = elements[idx]
                        # Filter by actual distance to be precise
                        dist = poly.distance(neighbor_elem["poly"])
                        neighbors.append({
                            "text": neighbor_elem["data"]["text"],
                            "distance": round(dist, 2)
                        })
                
                topology["tags"].append({
                    "tag": text,
                    "bbox": list(poly.bounds),
                    "neighbors": sorted(neighbors, key=lambda x: x["distance"])[:5] # Top 5 closest
                })

            # B. Connector Detection
            connector_match = self.connector_pattern.search(text)
            if connector_match:
                topology["connectors"].append({
                    "type": connector_match.group(1).upper(),
                    "ref": connector_match.group(2),
                    "text": text,
                    "bbox": list(poly.bounds)
                })

        chunk["topology"] = topology
        return chunk

    def _to_shapely(self, polygon_list: List[float]) -> Polygon:
        """Convert list of [x1,y1, x2,y2...] to Shapely Polygon"""
        if not polygon_list or len(polygon_list) < 6:
            return None
        try:
            # Group into (x,y) tuples
            points = list(zip(polygon_list[0::2], polygon_list[1::2]))
            return Polygon(points)
        except Exception:
            return None

    def format_to_text(self, chunk: Dict[str, Any]) -> str:
        """Convert chunk topology to LLM-readable text"""
        topology = chunk.get("topology", {})
        if not topology or "status" in topology:
            return ""
            
        text = "\n\n### P&ID Topology Analysis\n"
        
        # Tags
        tags = topology.get("tags", [])
        if tags:
            text += "#### Identified Tags (with nearby elements):\n"
            for t in tags:
                neighbors_str = ", ".join([f"{n['text']} (dist: {n['distance']})" for n in t.get("neighbors", [])])
                text += f"- **{t['tag']}**: Nearby: [{neighbors_str}]\n"
        
        # Connectors
        connectors = topology.get("connectors", [])
        if connectors:
            text += "#### Off-page Connectors:\n"
            for c in connectors:
                text += f"- {c['type']} {c['ref']} (Source Text: {c['text']})\n"
                
        return text

# Singleton
pid_processor = PIDProcessor()
