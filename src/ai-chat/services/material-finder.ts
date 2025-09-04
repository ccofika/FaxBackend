import mongoose from 'mongoose';
import Faculty from '../../models/Faculty';
import Department from '../../models/Department';
import Subject from '../../models/Subject';
import Material from '../../models/Material';
import TocAnalysis, { ITocAnalysis } from '../../models/TocAnalysis';
import DocumentSection from '../../models/DocumentSection';
import DocumentChunk from '../../models/DocumentChunk';

export interface MaterialSearchParams {
  facultyId?: string;
  facultyName?: string;
  departmentId?: string;
  departmentName?: string;
  year: number;
  subjectId?: string;
  subjectName?: string;
}

export interface MaterialInfo {
  materialId: string;
  title: string;
  type: string;
  status: string;
  hasToC: boolean;
  tocSections?: Array<{
    title: string;
    cleanTitle: string;
    level: number;
    pageStart: number;
    pageEnd: number;
    semanticType: string;
  }>;
  sectionsCount?: number;
  chunksCount?: number;
}

export interface SubjectMaterials {
  subjectId: string;
  subjectName: string;
  facultyId: string;
  facultyName: string;
  departmentId: string;
  departmentName: string;
  year: number;
  materials: MaterialInfo[];
  totalMaterials: number;
  readyMaterials: number; // Materials with status 'ready' or 'toc_ready'
}

export class MaterialFinder {
  
  /**
   * Find materials based on faculty, year, department/major, and subject parameters
   * This supports both ID-based and name-based searches for flexibility
   */
  async findMaterials(params: MaterialSearchParams): Promise<SubjectMaterials | null> {
    try {
      // First, resolve all the IDs if names are provided
      const resolvedParams = await this.resolveSearchParams(params);
      if (!resolvedParams) {
        return null;
      }

      // Find the subject with populated references
      const subject = await Subject.findById(resolvedParams.subjectId)
        .populate('facultyId', 'name')
        .populate('departmentId', 'name')
        .lean();

      if (!subject) {
        throw new Error(`Subject not found with ID: ${resolvedParams.subjectId}`);
      }

      // Find all materials for this subject
      const materials = await Material.find({
        subjectId: resolvedParams.subjectId,
        facultyId: resolvedParams.facultyId,
        departmentId: resolvedParams.departmentId,
        year: resolvedParams.year
      })
      .sort({ order: 1, title: 1 })
      .lean();

      // Get material details including ToC and processing status
      const materialDetails = await this.getMaterialDetails(materials);

      const readyCount = materials.filter(m => 
        m.status === 'ready' || m.status === 'toc_ready'
      ).length;

      return {
        subjectId: subject._id.toString(),
        subjectName: subject.name,
        facultyId: (subject.facultyId as any).name,
        facultyName: (subject.facultyId as any).name,
        departmentId: (subject.departmentId as any).name,
        departmentName: (subject.departmentId as any).name,
        year: subject.year,
        materials: materialDetails,
        totalMaterials: materials.length,
        readyMaterials: readyCount
      };

    } catch (error) {
      console.error('Error finding materials:', error);
      throw error;
    }
  }

  /**
   * Resolve search parameters by converting names to IDs when needed
   */
  private async resolveSearchParams(params: MaterialSearchParams): Promise<{
    facultyId: string;
    departmentId: string;
    subjectId: string;
    year: number;
  } | null> {
    try {
      let facultyId = params.facultyId;
      let departmentId = params.departmentId;
      let subjectId = params.subjectId;

      // Resolve faculty ID if only name is provided
      if (!facultyId && params.facultyName) {
        const faculty = await Faculty.findOne({ name: new RegExp(params.facultyName, 'i') }).lean();
        if (!faculty) {
          throw new Error(`Faculty not found: ${params.facultyName}`);
        }
        facultyId = faculty._id.toString();
      }

      // Resolve department ID if only name is provided
      if (!departmentId && params.departmentName && facultyId) {
        const department = await Department.findOne({ 
          name: new RegExp(params.departmentName, 'i'),
          facultyId: facultyId 
        }).lean();
        if (!department) {
          throw new Error(`Department not found: ${params.departmentName} in faculty ${params.facultyName || facultyId}`);
        }
        departmentId = department._id.toString();
      }

      // Resolve subject ID if only name is provided
      if (!subjectId && params.subjectName && facultyId && departmentId) {
        const subject = await Subject.findOne({
          name: new RegExp(params.subjectName, 'i'),
          facultyId: facultyId,
          departmentId: departmentId,
          year: params.year
        }).lean();
        if (!subject) {
          throw new Error(`Subject not found: ${params.subjectName} for year ${params.year}`);
        }
        subjectId = subject._id.toString();
      }

      if (!facultyId || !departmentId || !subjectId) {
        return null;
      }

      return {
        facultyId,
        departmentId,
        subjectId,
        year: params.year
      };

    } catch (error) {
      console.error('Error resolving search parameters:', error);
      throw error;
    }
  }

  /**
   * Get detailed information about materials including ToC and section counts
   */
  private async getMaterialDetails(materials: any[]): Promise<MaterialInfo[]> {
    const materialDetails: MaterialInfo[] = [];

    for (const material of materials) {
      const materialId = material._id.toString();
      
      // Check if material has ToC analysis
      const tocAnalysis = await TocAnalysis.findOne({ docId: materialId }).lean();
      
      // Get sections and chunks count for ready materials
      let sectionsCount = 0;
      let chunksCount = 0;
      
      if (material.status === 'ready' || material.status === 'toc_ready') {
        [sectionsCount, chunksCount] = await Promise.all([
          DocumentSection.countDocuments({ docId: materialId }),
          DocumentChunk.countDocuments({ docId: materialId })
        ]);
      }

      const materialInfo: MaterialInfo = {
        materialId,
        title: material.title,
        type: material.type,
        status: material.status,
        hasToC: !!tocAnalysis,
        sectionsCount,
        chunksCount
      };

      // Add ToC sections if available
      if (tocAnalysis && tocAnalysis.sections && tocAnalysis.sections.length > 0) {
        materialInfo.tocSections = tocAnalysis.sections.map((section: any) => ({
          title: section.title,
          cleanTitle: section.cleanTitle,
          level: section.level,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          semanticType: section.semanticType
        }));
      }

      materialDetails.push(materialInfo);
    }

    return materialDetails;
  }

  /**
   * Find materials by subject ID (quick lookup when you already have the subject ID)
   * TODO: This can be used in the user-end when the user selects a specific subject
   */
  async findMaterialsBySubjectId(subjectId: string): Promise<SubjectMaterials | null> {
    try {
      const subject = await Subject.findById(subjectId)
        .populate('facultyId', 'name')
        .populate('departmentId', 'name')
        .lean();

      if (!subject) {
        return null;
      }

      return this.findMaterials({
        facultyId: subject.facultyId.toString(),
        departmentId: subject.departmentId.toString(),
        subjectId: subjectId,
        year: subject.year
      });

    } catch (error) {
      console.error('Error finding materials by subject ID:', error);
      throw error;
    }
  }

  /**
   * Get available subjects for a specific faculty/department/year combination
   * TODO: This will be useful for user-end when building subject selection UI
   */
  async getAvailableSubjects(facultyId: string, departmentId: string, year: number): Promise<Array<{
    subjectId: string;
    subjectName: string;
    materialsCount: number;
    readyMaterialsCount: number;
  }>> {
    try {
      const subjects = await Subject.find({
        facultyId,
        departmentId,
        year
      })
      .sort({ order: 1, name: 1 })
      .lean();

      const subjectDetails = [];
      
      for (const subject of subjects) {
        const [totalCount, readyCount] = await Promise.all([
          Material.countDocuments({ subjectId: subject._id }),
          Material.countDocuments({ 
            subjectId: subject._id,
            status: { $in: ['ready', 'toc_ready'] }
          })
        ]);

        subjectDetails.push({
          subjectId: subject._id.toString(),
          subjectName: subject.name,
          materialsCount: totalCount,
          readyMaterialsCount: readyCount
        });
      }

      return subjectDetails;

    } catch (error) {
      console.error('Error getting available subjects:', error);
      throw error;
    }
  }
}

export const materialFinder = new MaterialFinder();